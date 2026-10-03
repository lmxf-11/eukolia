/**
 * ⚠️ SUPERSEDED — kept only for the visual-mode tree it still renders.
 *
 * The LaTeX analysis pipeline is now the ported LaTeX Workshop implementation:
 *
 *   - `parser/latexAnalyzer.ts` — `LatexDocumentAnalyzer`, the `DocumentAnalyzer`
 *     `DocumentModel` is constructed with. It produces the outline, labels,
 *     citations, macro definitions, environments, includes and sectioning from
 *     the reference's own unified-latex parser
 *     (`vendor/latex-workshop/parser/unified.ts`, vendored from LaTeX Workshop's
 *     `resources/unified.js`).
 *   - `parser/latexProject.ts` — multi-file outline across `\input`/`\include`.
 *   - `parser/bibParser.ts` — `parseBibtex(content, sourcePath)` for the project
 *     index.
 *
 * This module remains because `visual/VisualEditor.tsx`,
 * `visual/TableEditorWidget.tsx` and `ui/components/Sidebar.tsx` still import
 * its `ASTNode` / `OutlineItem` types; those files are being replaced. Do not
 * extend it, and prefer `LatexDocumentAnalyzer` for anything new.
 *
 * --- original header ---
 *
 * Eukolia Lossless LaTeX Concrete Syntax Tree (CST) & AST Parser
 *
 * Implements a resilient, error-tolerant parser that produces a lossless
 * concrete syntax representation of LaTeX documents.
 *
 * Invariants:
 * - Every node maintains precise [start, end] source offsets and verbatim 'raw' string.
 * - Incomplete syntax during typing is represented with `isIncomplete: true` without throwing.
 * - Semantic constructs (sections, math, theorems, lists, raw-LaTeX islands, macros, labels)
 *   are faithfully classified for Visual Mode and Language Services.
 */

export type ASTNodeType =
  | 'root'
  | 'preamble'
  | 'section'
  | 'paragraph'
  | 'inline-math'
  | 'display-math'
  | 'theorem'
  | 'list'
  | 'list-item'
  | 'table'
  | 'figure'
  | 'title'
  | 'footnote'
  | 'environment'
  | 'command'
  | 'raw-island'
  | 'macro-def'
  | 'label'
  | 'cite'
  | 'include'
  | 'comment'
  | 'text';

export interface OutlineItem {
  id: string;
  title: string;
  level: number; // 1: part, 2: chapter, 3: section, 4: subsection, 5: subsubsection, 6: paragraph
  line: number;
  startOffset: number;
  endOffset: number;
}

export interface ASTNode {
  id: string;
  type: ASTNodeType;
  start: number;
  end: number;
  line: number;
  raw: string;
  name?: string;
  value?: string;
  content?: string;
  isIncomplete?: boolean;
  attributes?: Record<string, any>;
  children?: ASTNode[];
}

export interface ParsedDocument {
  ast: ASTNode;
  outline: OutlineItem[];
  macros: Map<string, string>;
  labels: Set<string>;
  citations: Set<string>;
  includes: string[];
}

export const SECTION_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
  paragraph: 6
};

export const THEOREM_ENVIRONMENTS = new Set([
  'theorem',
  'lemma',
  'proof',
  'definition',
  'proposition',
  'corollary',
  'example',
  'remark',
  'conjecture',
  'claim',
  'exercise',
  'axiom',
  'hypothesis'
]);

export const MATH_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'split',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'cases',
  'aligned',
  'gathered'
]);

export const LIST_ENVIRONMENTS = new Set([
  'itemize',
  'enumerate',
  'description'
]);

export const TABLE_ENVIRONMENTS = new Set([
  'tabular',
  'tabular*',
  'array'
]);

export const FIGURE_ENVIRONMENTS = new Set([
  'figure',
  'figure*'
]);

/**
 * Extracts balanced braces `{...}` starting at or after `startIdx`.
 * Returns null if not found or unclosed.
 */
export function extractBalancedBraces(
  text: string,
  startIdx: number
): { content: string; openIndex: number; endIndex: number } | null {
  const openIdx = text.indexOf('{', startIdx);
  if (openIdx === -1) return null;

  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{' && (i === 0 || text[i - 1] !== '\\')) {
      depth++;
    } else if (text[i] === '}' && (i === 0 || text[i - 1] !== '\\')) {
      depth--;
      if (depth === 0) {
        return {
          content: text.substring(openIdx + 1, i),
          openIndex: openIdx,
          endIndex: i
        };
      }
    }
  }

  // Tolerant return if unclosed at EOF
  return {
    content: text.substring(openIdx + 1),
    openIndex: openIdx,
    endIndex: text.length
  };
}

/**
 * Extracts optional brackets `[...]` starting at `startIdx`.
 */
export function extractOptionalBracket(
  text: string,
  startIdx: number
): { content: string; openIndex: number; endIndex: number } | null {
  const trimmedOffset = text.slice(startIdx).search(/\S/);
  if (trimmedOffset === -1) return null;
  const actualStart = startIdx + trimmedOffset;
  if (text[actualStart] !== '[') return null;

  let depth = 0;
  for (let i = actualStart; i < text.length; i++) {
    if (text[i] === '[' && (i === 0 || text[i - 1] !== '\\')) {
      depth++;
    } else if (text[i] === ']' && (i === 0 || text[i - 1] !== '\\')) {
      depth--;
      if (depth === 0) {
        return {
          content: text.substring(actualStart + 1, i),
          openIndex: actualStart,
          endIndex: i
        };
      }
    }
  }
  return null;
}

export class LatexParser {
  private static nodeIdCounter = 0;

  private static nextId(prefix: string = 'node'): string {
    return `${prefix}-${++this.nodeIdCounter}`;
  }

  /**
   * Main parsing entry point.
   */
  public static parse(content: string): ParsedDocument {
    this.nodeIdCounter = 0;
    const outline: OutlineItem[] = [];
    const macros = new Map<string, string>();
    const labels = new Set<string>();
    const citations = new Set<string>();
    const includes: string[] = [];

    const rootNode: ASTNode = {
      id: 'root',
      type: 'root',
      start: 0,
      end: content.length,
      line: 1,
      raw: content,
      children: []
    };

    if (!content.trim()) {
      return { ast: rootNode, outline, macros, labels, citations, includes };
    }

    // 1. Check for document preamble
    const beginDocMatch = content.match(/\\begin\{document\}/);
    let bodyStartOffset = 0;

    if (beginDocMatch && beginDocMatch.index !== undefined) {
      const preambleEnd = beginDocMatch.index + beginDocMatch[0].length;
      const preambleRaw = content.substring(0, preambleEnd);
      const preambleNode: ASTNode = {
        id: this.nextId('preamble'),
        type: 'preamble',
        start: 0,
        end: preambleEnd,
        line: 1,
        raw: preambleRaw,
        content: preambleRaw,
        children: []
      };

      // Extract preamble macros, packages, and classes
      this.extractPreambleMetadata(preambleRaw, macros, includes, preambleNode);
      rootNode.children!.push(preambleNode);
      bodyStartOffset = preambleEnd;
    }

    // Check for \end{document}
    const endDocMatch = content.match(/\\end\{document\}/);
    let bodyEndOffset = content.length;
    if (endDocMatch && endDocMatch.index !== undefined) {
      bodyEndOffset = endDocMatch.index;
    }

    // 2. Parse body blocks
    const bodyText = content.substring(bodyStartOffset, bodyEndOffset);
    const bodyNodes = this.parseBodyBlocks(bodyText, bodyStartOffset, content);

    for (const node of bodyNodes) {
      rootNode.children!.push(node);
      this.collectSemantics(node, outline, labels, citations, macros, includes);
    }

    // 3. Trailing \end{document} or post-document content
    if (bodyEndOffset < content.length) {
      const postDocRaw = content.substring(bodyEndOffset);
      rootNode.children!.push({
        id: this.nextId('postamble'),
        type: 'raw-island',
        start: bodyEndOffset,
        end: content.length,
        line: this.getLineNumber(content, bodyEndOffset),
        raw: postDocRaw,
        content: postDocRaw
      });
    }

    return {
      ast: rootNode,
      outline,
      macros,
      labels,
      citations,
      includes
    };
  }

  /**
   * Parses the body of the LaTeX document into semantic blocks.
   */
  private static parseBodyBlocks(
    bodyText: string,
    baseOffset: number,
    fullContent: string
  ): ASTNode[] {
    const nodes: ASTNode[] = [];
    let cursor = 0;
    const len = bodyText.length;

    while (cursor < len) {
      // Skip empty whitespace
      const wsMatch = bodyText.slice(cursor).match(/^\s+/);
      if (wsMatch) {
        cursor += wsMatch[0].length;
        if (cursor >= len) break;
      }

      const currentAbsolute = baseOffset + cursor;
      const currentLine = this.getLineNumber(fullContent, currentAbsolute);
      const remaining = bodyText.slice(cursor);

      // 1. Comments: % ...
      if (remaining.startsWith('%')) {
        const lineEnd = remaining.indexOf('\n');
        const commentLen = lineEnd === -1 ? remaining.length : lineEnd;
        const raw = remaining.substring(0, commentLen);
        nodes.push({
          id: this.nextId('comment'),
          type: 'comment',
          start: currentAbsolute,
          end: currentAbsolute + commentLen,
          line: currentLine,
          raw,
          content: raw.substring(1).trim()
        });
        cursor += commentLen;
        continue;
      }

      // 2. Headings: \section{...}, \subsection*{...}, etc.
      const secMatch = remaining.match(/^\\(part|chapter|section|subsection|subsubsection|paragraph)\*?/);
      if (secMatch) {
        const cmd = secMatch[1];
        const afterCmdIdx = secMatch[0].length;
        const braces = extractBalancedBraces(remaining, afterCmdIdx);
        if (braces) {
          const totalLen = braces.endIndex + 1;
          const raw = remaining.substring(0, totalLen);
          const title = braces.content.trim();
          nodes.push({
            id: this.nextId('sec'),
            type: 'section',
            start: currentAbsolute,
            end: currentAbsolute + totalLen,
            line: currentLine,
            name: cmd,
            value: title,
            content: title,
            raw,
            attributes: {
              level: SECTION_LEVELS[cmd] || 3,
              starred: secMatch[0].includes('*')
            }
          });
          cursor += totalLen;
          continue;
        }
      }

      // 3. Display Math: \[ ... \] or $$ ... $$
      if (remaining.startsWith('\\[') || remaining.startsWith('$$')) {
        const isBracket = remaining.startsWith('\\[');
        const closeToken = isBracket ? '\\]' : '$$';
        const startTokenLen = 2;
        const closeIdx = remaining.indexOf(closeToken, startTokenLen);
        const mathEnd = closeIdx === -1 ? remaining.length : closeIdx + closeToken.length;
        const raw = remaining.substring(0, mathEnd);
        const mathContent = closeIdx === -1
          ? remaining.substring(startTokenLen).trim()
          : remaining.substring(startTokenLen, closeIdx).trim();

        nodes.push({
          id: this.nextId('math-disp'),
          type: 'display-math',
          start: currentAbsolute,
          end: currentAbsolute + mathEnd,
          line: currentLine,
          raw,
          content: mathContent,
          value: mathContent,
          isIncomplete: closeIdx === -1
        });
        cursor += mathEnd;
        continue;
      }

      // 4. Environments: \begin{envName} ... \end{envName}
      const beginMatch = remaining.match(/^\\begin\{([a-zA-Z0-9*]+)\}/);
      if (beginMatch) {
        const envName = beginMatch[1];
        const endToken = `\\end{${envName}}`;
        const endIdx = remaining.indexOf(endToken, beginMatch[0].length);
        const envEnd = endIdx === -1 ? remaining.length : endIdx + endToken.length;
        const raw = remaining.substring(0, envEnd);
        const innerBody = endIdx === -1
          ? remaining.substring(beginMatch[0].length)
          : remaining.substring(beginMatch[0].length, endIdx);

        // Classify environment
        if (MATH_ENVIRONMENTS.has(envName)) {
          nodes.push({
            id: this.nextId('math-env'),
            type: 'display-math',
            name: envName,
            start: currentAbsolute,
            end: currentAbsolute + envEnd,
            line: currentLine,
            raw,
            content: raw,
            value: innerBody.trim(),
            isIncomplete: endIdx === -1
          });
        } else if (THEOREM_ENVIRONMENTS.has(envName.toLowerCase())) {
          // Check for theorem optional argument: \begin{theorem}[Pythagoras]
          const optArg = extractOptionalBracket(remaining, beginMatch[0].length);
          const theoremTitle = optArg ? optArg.content.trim() : undefined;
          const bodyStart = optArg ? (optArg.endIndex + 1) : beginMatch[0].length;
          const actualBody = endIdx === -1
            ? remaining.substring(bodyStart)
            : remaining.substring(bodyStart, endIdx);
          nodes.push({
            id: this.nextId('thm'),
            type: 'theorem',
            name: envName,
            start: currentAbsolute,
            end: currentAbsolute + envEnd,
            line: currentLine,
            raw,
            content: actualBody.trim(),
            value: theoremTitle,
            attributes: { title: theoremTitle },
            isIncomplete: endIdx === -1
          });
        } else if (LIST_ENVIRONMENTS.has(envName)) {
          const listNode: ASTNode = {
            id: this.nextId('list'),
            type: 'list',
            name: envName,
            start: currentAbsolute,
            end: currentAbsolute + envEnd,
            line: currentLine,
            raw,
            content: innerBody.trim(),
            children: this.parseListItems(innerBody, currentAbsolute + beginMatch[0].length, fullContent),
            isIncomplete: endIdx === -1
          };
          nodes.push(listNode);
        } else if (TABLE_ENVIRONMENTS.has(envName)) {
          // Parse colSpec and rows/cells
          const colSpecMatch = extractBalancedBraces(remaining, beginMatch[0].length);
          const colSpec = colSpecMatch ? colSpecMatch.content.trim() : 'cc';
          const bodyStart = colSpecMatch ? colSpecMatch.endIndex + 1 : beginMatch[0].length;
          const tableContent = endIdx === -1 ? remaining.substring(bodyStart) : remaining.substring(bodyStart, endIdx);
          
          // Split rows by unescaped \\
          const rawRows = tableContent.split(/(?<!\\)\\\\/g);
          const rows: string[][] = [];
          for (const rawRow of rawRows) {
            const cleanRow = rawRow.replace(/\\hline/g, '').trim();
            if (!cleanRow && rawRows.length > 1 && rawRow === rawRows[rawRows.length - 1]) continue;
            // Split cells by unescaped &
            const cells = cleanRow.split(/(?<!\\)&/g).map(c => c.trim());
            rows.push(cells);
          }

          nodes.push({
            id: this.nextId('tbl'),
            type: 'table',
            name: envName,
            start: currentAbsolute,
            end: currentAbsolute + envEnd,
            line: currentLine,
            raw,
            content: innerBody.trim(),
            value: colSpec,
            attributes: {
              colSpec,
              rows: rows.length > 0 ? rows : [['', ''], ['', '']]
            },
            isIncomplete: endIdx === -1
          });
        } else if (FIGURE_ENVIRONMENTS.has(envName)) {
          // Extract \includegraphics, \caption, \label
          const imgMatch = innerBody.match(/\\includegraphics(?:\[(.*?)\])?\{([^}]+)\}/);
          const captionMatch = innerBody.match(/\\caption\{([^}]+)\}/);
          const labelMatch = innerBody.match(/\\label\{([^}]+)\}/);
          
          nodes.push({
            id: this.nextId('fig'),
            type: 'figure',
            name: envName,
            start: currentAbsolute,
            end: currentAbsolute + envEnd,
            line: currentLine,
            raw,
            content: innerBody.trim(),
            attributes: {
              imagePath: imgMatch ? imgMatch[2].trim() : '',
              options: imgMatch && imgMatch[1] ? imgMatch[1].trim() : '',
              caption: captionMatch ? captionMatch[1].trim() : '',
              label: labelMatch ? labelMatch[1].trim() : ''
            },
            isIncomplete: endIdx === -1
          });
        } else {
          // Generic environment or Raw Island if unsupported
          nodes.push({
            id: this.nextId('env'),
            type: 'environment',
            name: envName,
            start: currentAbsolute,
            end: currentAbsolute + envEnd,
            line: currentLine,
            raw,
            content: innerBody.trim(),
            value: innerBody.trim(),
            isIncomplete: endIdx === -1
          });
        }

        cursor += envEnd;
        continue;
      }

      // 5. Macro definitions: \newcommand, \renewcommand, etc.
      const macroMatch = remaining.match(/^\\(newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\?([a-zA-Z]+)\}?/);
      if (macroMatch) {
        const macroName = macroMatch[2];
        const afterNameIdx = macroMatch[0].length;
        const braces = extractBalancedBraces(remaining, afterNameIdx);
        if (braces) {
          const macroEnd = braces.endIndex + 1;
          const raw = remaining.substring(0, macroEnd);
          nodes.push({
            id: this.nextId('macro'),
            type: 'macro-def',
            name: macroName,
            start: currentAbsolute,
            end: currentAbsolute + macroEnd,
            line: currentLine,
            raw,
            content: braces.content,
            value: braces.content
          });
          cursor += macroEnd;
          continue;
        }
      }

      // 6. Title / Maketitle command
      if (remaining.startsWith('\\maketitle')) {
        const cmdLen = '\\maketitle'.length;
        nodes.push({
          id: this.nextId('title'),
          type: 'title',
          name: 'maketitle',
          start: currentAbsolute,
          end: currentAbsolute + cmdLen,
          line: currentLine,
          raw: '\\maketitle',
          content: 'Title Banner'
        });
        cursor += cmdLen;
        continue;
      }

      // 7. Standalone Raw Islands (unknown commands like \myCustomMacro[opt]{arg})
      const unknownCmdMatch = remaining.match(/^\\([a-zA-Z@]+)\*?/);
      if (unknownCmdMatch && !['textbf', 'emph', 'underline', 'texttt', 'item', 'label', 'ref', 'cite'].includes(unknownCmdMatch[1])) {
        // If it's a standalone macro line, treat as raw island
        const lineBreak = remaining.indexOf('\n');
        const rawLen = lineBreak === -1 ? remaining.length : lineBreak;
        const raw = remaining.substring(0, rawLen);
        if (raw.trim().startsWith('\\')) {
          nodes.push({
            id: this.nextId('island'),
            type: 'raw-island',
            name: unknownCmdMatch[1],
            start: currentAbsolute,
            end: currentAbsolute + rawLen,
            line: currentLine,
            raw,
            content: raw
          });
          cursor += rawLen;
          continue;
        }
      }

      // 7. Text Paragraph
      // Consume characters until a blank line or a major block boundary (\section, \begin, \[, $$, %)
      const paraRegex = /\n\s*\n|(?=\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{)|(?=\\begin\{)|(?=\\\[)|(?=\$\$)|(?=^%)/m;
      const match = remaining.search(paraRegex);
      const paraLen = match === -1 ? remaining.length : match;
      const paraRaw = remaining.substring(0, paraLen);

      if (paraRaw.trim().length > 0) {
        nodes.push({
          id: this.nextId('para'),
          type: 'paragraph',
          start: currentAbsolute,
          end: currentAbsolute + paraLen,
          line: currentLine,
          raw: paraRaw,
          content: paraRaw.trim()
        });
      }

      cursor += paraLen;
    }

    return nodes;
  }

  /**
   * Parses list items `\item ...` within an itemize or enumerate environment.
   */
  private static parseListItems(
    innerBody: string,
    bodyOffset: number,
    fullContent: string
  ): ASTNode[] {
    const items: ASTNode[] = [];
    const itemMatches = Array.from(innerBody.matchAll(/\\item(?:\s*\[([^\]]*)\])?/g));

    for (let i = 0; i < itemMatches.length; i++) {
      const match = itemMatches[i];
      const startIdx = match.index!;
      const endIdx = i + 1 < itemMatches.length ? itemMatches[i + 1].index! : innerBody.length;
      const raw = innerBody.substring(startIdx, endIdx);
      const itemText = innerBody.substring(startIdx + match[0].length, endIdx).trim();

      items.push({
        id: this.nextId('item'),
        type: 'list-item',
        start: bodyOffset + startIdx,
        end: bodyOffset + endIdx,
        line: this.getLineNumber(fullContent, bodyOffset + startIdx),
        raw,
        content: itemText,
        attributes: {
          label: match[1]
        }
      });
    }

    return items;
  }

  /**
   * Scans preamble for \newcommand, \usepackage, \documentclass, \input.
   */
  private static extractPreambleMetadata(
    preamble: string,
    macros: Map<string, string>,
    includes: string[],
    preambleNode: ASTNode
  ): void {
    // 1. \newcommand / \def
    const macroRegex = /\\(?:newcommand|renewcommand|providecommand)\s*\{?\\?([a-zA-Z]+)\}?\s*\{([^}]+)\}/g;
    let m;
    while ((m = macroRegex.exec(preamble)) !== null) {
      macros.set(m[1], m[2]);
    }

    // 2. \input{...} or \include{...}
    const incRegex = /\\(?:input|include)\{([^}]+)\}/g;
    while ((m = incRegex.exec(preamble)) !== null) {
      includes.push(m[1].trim());
    }
  }

  /**
   * Traverses an AST node to collect semantic indexes (outline, labels, citations, macros, includes).
   */
  private static collectSemantics(
    node: ASTNode,
    outline: OutlineItem[],
    labels: Set<string>,
    citations: Set<string>,
    macros: Map<string, string>,
    includes: string[]
  ): void {
    // Sections -> Outline
    if (node.type === 'section' && node.name && node.content) {
      outline.push({
        id: `outline-${outline.length + 1}`,
        title: node.content,
        level: node.attributes?.level || 3,
        line: node.line,
        startOffset: node.start,
        endOffset: node.end
      });
    }

    // Macro def
    if (node.type === 'macro-def' && node.name && node.content) {
      macros.set(node.name, node.content);
    }

    // Search raw for \label{...}, \cite{...}, \input{...}
    const raw = node.raw;
    const labelMatches = raw.matchAll(/\\label\{([^}]+)\}/g);
    for (const lm of labelMatches) {
      labels.add(lm[1].trim());
    }

    const citeMatches = raw.matchAll(/\\cite\{([^}]+)\}/g);
    for (const cm of citeMatches) {
      cm[1].split(',').forEach(c => citations.add(c.trim()));
    }

    const incMatches = raw.matchAll(/\\(?:input|include)\{([^}]+)\}/g);
    for (const im of incMatches) {
      includes.push(im[1].trim());
    }

    // Recurse children
    if (node.children) {
      for (const child of node.children) {
        this.collectSemantics(child, outline, labels, citations, macros, includes);
      }
    }
  }

  private static getLineNumber(content: string, offset: number): number {
    return content.substring(0, offset).split('\n').length;
  }
}
