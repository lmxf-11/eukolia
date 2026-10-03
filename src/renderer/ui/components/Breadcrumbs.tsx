/**
 * Breadcrumbs — the path strip above the editor.
 *
 * This is VS Code's breadcrumb bar: where the file sits in the project, followed
 * by the chain of LaTeX sectioning commands the caret is inside. It answers "where
 * am I?" without the explorer or the outline having to be open, which is the whole
 * reason VS Code puts it there.
 *
 * Both halves are derived, never stored:
 *
 *  * the path comes from the document's own URI relative to the project root, so
 *    it cannot disagree with the explorer's tree;
 *  * the symbol chain comes from `DocumentModel.getOutline()`, which is produced
 *    by the ported LaTeX Workshop analyzer, so it cannot disagree with the
 *    outline view.
 *
 * The two derivations are pure functions, exported and tested, because they are
 * the parts that are easy to get subtly wrong — a path that keeps a leading
 * separator, or a chain that includes a section the caret has already left.
 */

import React from 'react';
import { useAppState } from '../state';
import type { OutlineItem } from '../../document/analysisTypes';
import { ChevronRight, FileText } from './icons';

/** One crumb. `offset` is set when clicking it can move the caret. */
export interface Crumb {
  label: string;
  title: string;
  offset?: number;
}

/**
 * The project-relative path of a file, as crumbs.
 *
 * The file name is last. A path outside the project keeps its absolute form
 * rather than being silently truncated to something that looks project-relative
 * but is not.
 */
export function pathCrumbs(filePath: string | null, projectRoot: string | null): string[] {
  if (!filePath) return [];

  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = normalize(filePath);
  const root = projectRoot ? normalize(projectRoot) : null;

  let relative = file;
  if (root && (file === root || file.startsWith(`${root}/`))) {
    relative = file.slice(root.length).replace(/^\/+/, '');
  }

  return relative.split('/').filter((segment) => segment.length > 0);
}

/**
 * The chain of sectioning commands enclosing `offset`.
 *
 * Walks the outline tree and returns the ancestors of the *deepest* item that
 * starts at or before the offset — so a caret in the second paragraph of a
 * subsection shows `\section > \subsection`, and a caret in the preamble shows
 * nothing at all rather than the first section in the document.
 *
 * The recursion returns the chain it found rather than appending to a shared
 * accumulator: with an accumulator the caller cannot tell "my child found nothing
 * deeper" from "my child found a chain of the same length", so a subsection
 * nested under a later section was reported as its section alone.
 */
export function outlinePathAt(items: readonly OutlineItem[], offset: number): OutlineItem[] {
  const deepest = (
    nodes: readonly OutlineItem[],
    ancestors: OutlineItem[]
  ): OutlineItem[] | null => {
    let best: OutlineItem[] | null = null;
    for (const node of nodes) {
      // The outline is in document order, so once an item starts after the caret
      // neither it nor anything following it can enclose the caret.
      if (node.offset > offset) break;
      const next = [...ancestors, node];
      best = deepest(node.children, next) ?? next;
    }
    return best;
  };

  return deepest(items, []) ?? [];
}

/** Builds the crumbs for the current document and caret position. */
export function buildCrumbs(options: {
  filePath: string | null;
  projectRoot: string | null;
  outline: readonly OutlineItem[];
  offset: number;
}): Crumb[] {
  // Without a document there is no caret, so `offset` means nothing and a symbol
  // chain would be a claim about a file that is not open.
  if (!options.filePath) return [];

  const crumbs: Crumb[] = [];

  const path = pathCrumbs(options.filePath, options.projectRoot);
  for (const segment of path) {
    const isFile = segment === path[path.length - 1];
    crumbs.push({
      label: segment,
      title: isFile ? (options.filePath ?? segment) : `${segment}/`
    });
  }

  for (const item of outlinePathAt(options.outline, options.offset)) {
    crumbs.push({
      label: item.title,
      title: `\\${item.command}{${item.title}} — line ${item.line}`,
      offset: item.offset
    });
  }

  return crumbs;
}

export const Breadcrumbs: React.FC = () => {

  const state = useAppState();
  const { activeDocument, workspace, outline, cursor } = state;

  if (!activeDocument) return null;

  const crumbs = buildCrumbs({
    filePath: activeDocument.doc.uri,
    projectRoot: workspace.workspacePath,
    outline,
    offset: cursor.offset
  });

  if (crumbs.length === 0) return null;

  return (
    <div className="eu-breadcrumbs" style={bar} data-testid="breadcrumbs" aria-label="Breadcrumb">
      <FileText size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} />
      {crumbs.map((crumb, index) => (
        <React.Fragment key={`${crumb.label}-${index}`}>
          {index > 0 && (
            /*
             * The separator is dimmer than either crumb, and it is what makes
             * the strip readable as a *path* rather than as a row of words: the
             * eye follows one chain instead of parsing a list.
             */
            <ChevronRight className="eu-breadcrumbs__sep" size={11} strokeWidth={2} />
          )}
          {crumb.offset === undefined ? (
            // A path segment is shown but not clickable: Eukolia has no action to
            // take for it, and a button that does nothing is worse than a label.
            <span className="eu-breadcrumbs__plain" title={crumb.title} data-testid="breadcrumb-plain">
              {crumb.label}
            </span>
          ) : (
            <button
              type="button"
              className="eu-breadcrumbs__link"
              title={crumb.title}
              data-testid="breadcrumb-symbol"
              onClick={() => {
                // The editor handle, so a crumb reveals the position in the one
                // editor, whichever mode it is in.
                state.editorHandleRef.current?.revealOffset(crumb.offset as number);
              }}
            >
              {crumb.label}
            </button>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

/**
 * The strip's geometry. Everything above it — the surface, the type scale, the
 * colour of a path segment against a section name, the hover on the clickable
 * crumbs — is in `ui/eukolia-shell.css`, beside the strips it sits between.
 */
const bar: React.CSSProperties = {
  height: 24,
  flexShrink: 0
};

export default Breadcrumbs;