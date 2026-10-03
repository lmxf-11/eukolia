/**
 * Eukolia — TeX ampersand aligner.
 *
 * Ported from the reference implementation:
 *   References/tex-aligner/src/extension.ts
 *
 * The alignment algorithm (`formatTex`, `formatSelectedEnvironments` and the
 * environment stack scan) is kept verbatim; only the VS Code adapter layer
 * (`vscode.TextEdit`, `Range`, `Position`, `workspace.getConfiguration`) has been
 * replaced with offset-based, editor-agnostic types so the same code can drive
 * Monaco, CodeMirror and plain documents.
 *
 * Original licence: MIT (see vendor-licenses/tex-aligner-*). Modified for Eukolia.
 */

/** Environments aligned by default — the reference's `texAligner.environments` default. */
export const DEFAULT_TARGET_ENVIRONMENTS: readonly string[] = [
  'align',
  'align*',
  'aligned',
  'matrix',
  'pmatrix',
  'pmatrix*',
  'bmatrix',
  'bmatrix*',
  'vmatrix',
  'vmatrix*',
  'Vmatrix',
  'Vmatrix*',
  'Bmatrix',
  'Bmatrix*',
  'array',
  'array*',
  'tabular',
  'tikzcd',
  'case',
  'alignedat'
];

export interface AlignOptions {
  /**
   * Environments to align. Defaults to `DEFAULT_TARGET_ENVIRONMENTS`.
   */
  environments?: readonly string[];
  /**
   * Eukolia extension: when set, `&` is padded to this many spaces on each side
   * instead of the single space the reference produces. `1` reproduces the
   * reference behaviour exactly.
   */
  ampersandPadding?: number;
}

/**
 * A text replacement expressed as a character-offset range, replacing the
 * VS Code `TextEdit` the reference produced.
 */
export interface AlignEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

interface ParsedLine {
  cells: string[];
  isRaw: boolean;
  originalLine: string;
  indentation: string;
  lineSuffix: string;
}

/**
 * Alignment engine over a single in-memory string.
 *
 * This is the reference's `formatTex` plus the surrounding environment scan from
 * `formatSelectedEnvironments`, with the position math converted from
 * `vscode.Position` to plain character offsets.
 */
export class TexAligner {
  private readonly environments: readonly string[];
  private readonly ampersandPadding: number;

  constructor(options: AlignOptions = {}) {
    this.environments = options.environments ?? DEFAULT_TARGET_ENVIRONMENTS;
    this.ampersandPadding = Math.max(1, options.ampersandPadding ?? 1);
  }

  public getEnvironments(): readonly string[] {
    return this.environments;
  }

  /**
   * Reference: `formatSelectedEnvironments`.
   *
   * Scans `text` for `\begin{...}` / `\end{...}` pairs and returns the edits that
   * align each outermost targeted environment. Nested target environments are
   * left to their outer environment, exactly as the reference does.
   *
   * @param text     the text to scan
   * @param baseOffset offset of `text` within the document; returned edit offsets
   *                   are absolute (i.e. `baseOffset + index`).
   */
  public computeEdits(text: string, baseOffset = 0): AlignEdit[] {
    const edits: AlignEdit[] = [];
    const envRegex = /\\(begin|end)\{([a-zA-Z0-9*]+)\}/g;
    let match: RegExpExecArray | null;
    const stack: { name: string; startIndex: number }[] = [];

    while ((match = envRegex.exec(text)) !== null) {
      const type = match[1];
      const envName = match[2];
      const fullTag = match[0];
      const index = match.index;

      if (type === 'begin') {
        stack.push({ name: envName, startIndex: index });
      } else {
        if (stack.length === 0) {
          continue;
        }
        const startTag = stack.pop();

        if (startTag && startTag.name === envName) {
          if (this.environments.includes(envName)) {
            const isNestedInTarget = stack.some((s) => this.environments.includes(s.name));

            if (!isNestedInTarget) {
              const endIndex = index + fullTag.length;
              const blockContent = text.substring(startTag.startIndex, endIndex);
              const formattedBlock = this.formatEnvironment(blockContent);

              if (blockContent !== formattedBlock) {
                edits.push({
                  start: baseOffset + startTag.startIndex,
                  end: baseOffset + endIndex,
                  newText: formattedBlock
                });
              }
            }
          }
        }
      }
    }
    return edits;
  }

  /**
   * Alignment of every targeted environment in a whole document.
   * Returns the formatted text.
   */
  public formatDocument(text: string): string {
    return applyAlignEdits(text, this.computeEdits(text));
  }

  /** Reference: `formatTex` — align one environment block (including its delimiters). */
  public formatEnvironment(text: string): string {
    const lines = text.split(/\r?\n/);

    const parsedLines: ParsedLine[] = lines.map((line) => {
      // Preserve exact indentation of the line
      const indentationMatch = line.match(/^\s*/);
      const indentation = indentationMatch ? indentationMatch[0] : '';

      const trimmed = line.trim();

      // Identify "Raw" lines: Comments or Delimiters (includes 'hline')
      const isComment = trimmed.startsWith('%');
      const isDelimiter = /^\\(begin|end|\[|\]|hline)/.test(trimmed);
      const isRaw = isDelimiter || isComment;

      let content = trimmed;
      let lineSuffix = '';

      // Remove existing \\ at the end safely
      if (!isRaw) {
        // Extract \hline if present at the end of the line
        const suffixMatch = content.match(/(?:\s*\\hline)+$/);
        if (suffixMatch) {
          lineSuffix = suffixMatch[0].trim();
          content = content.substring(0, content.length - suffixMatch[0].length).trim();
        }

        if (content.endsWith('\\\\')) {
          if (!content.endsWith('\\\\\\')) {
            content = content.substring(0, content.length - 2).trim();
          }
        }
      }

      const cells = isRaw ? [line] : content.split(/(?<!\\)&/g).map((c) => c.trim());

      return { cells, isRaw, originalLine: line, indentation, lineSuffix };
    });

    const dataRows = parsedLines.filter((row) => !row.isRaw);

    // 1. Indentation Normalization
    let targetIndentation = '';
    if (dataRows.length > 0) {
      targetIndentation = dataRows.reduce((shortest, row) => {
        return row.indentation.length < shortest.length ? row.indentation : shortest;
      }, dataRows[0].indentation);
    }

    let lastDataRowIndex = -1;
    for (let i = parsedLines.length - 1; i >= 0; i--) {
      if (!parsedLines[i].isRaw) {
        lastDataRowIndex = i;
        break;
      }
    }

    // 3. Calculate Column Widths
    const maxCols = dataRows.length > 0 ? Math.max(...dataRows.map((r) => r.cells.length)) : 0;

    if (maxCols > 0) {
      dataRows.forEach((row) => {
        while (row.cells.length < maxCols) {
          row.cells.push('');
        }
      });
    }

    const colWidths = new Array<number>(maxCols).fill(0);
    dataRows.forEach((row) => {
      row.cells.forEach((cell, i) => {
        if (cell.length > colWidths[i]) {
          colWidths[i] = cell.length;
        }
      });
    });

    // 4. Reconstruct (updated for \\ alignment and line suffixes)
    const separator = ' '.repeat(this.ampersandPadding) + '&' + ' '.repeat(this.ampersandPadding);

    return parsedLines
      .map((row, index) => {
        if (row.isRaw) {
          return row.originalLine;
        }

        const isLastDataRow = index === lastDataRowIndex;

        const paddedCells = row.cells.map((cell, i) => {
          const isLastCell = i === row.cells.length - 1;

          if (!isLastCell) {
            return cell.padEnd(colWidths[i]);
          } else {
            // For the last cell: pad if we are appending \\ (not last row, OR has a suffix like \hline)
            if (!isLastDataRow || row.lineSuffix) {
              return cell.padEnd(colWidths[i]);
            }
            return cell;
          }
        });

        let newField = paddedCells.join(separator);

        // Add \\ if it's not the last data row, OR if it has a lineSuffix
        if (!isLastDataRow || row.lineSuffix) {
          newField += ' \\\\';
        } else {
          newField = newField.trimEnd();
        }

        // Re-attach \hline at the very end
        if (row.lineSuffix) {
          newField += ' ' + row.lineSuffix;
        }

        return targetIndentation + newField;
      })
      .join('\n');
  }
}

/**
 * Applies align edits to `text`, back-to-front so earlier offsets stay valid.
 * `edits` must be non-overlapping and sorted by `start` ascending.
 */
export function applyAlignEdits(text: string, edits: readonly AlignEdit[]): string {
  if (edits.length === 0) return text;
  let result = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    result = result.substring(0, edit.start) + edit.newText + result.substring(edit.end);
  }
  return result;
}

/** Shared default instance, configured with the reference's default environment list. */
export const defaultAligner = new TexAligner();

/** Reference-compatible alias. */
export const formatTex = (text: string): string => defaultAligner.formatEnvironment(text);
