/**
 * Eukolia — adapter that feeds the ported LaTeX Workshop completion providers.
 *
 * The providers are pure functions over `{ args, project }`; this module builds
 * those two objects from Eukolia's project index and document store, and
 * registers the result as a completion source so `completionRegistry` collects
 * LaTeX Workshop suggestions alongside Eukolia's own.
 */

import {
  dispatchOrder,
  preloadCompletionData,
  provideCompletionOfType,
  provideLatexCompletions,
  provideAtSuggestions
} from '../vendor/latex-workshop/completion/latex';
import type {
  CitationCompletionEntry,
  CompletionContext as LwCompletionContext,
  CompletionProjectState,
  FileCompletionEntry,
  LabelCompletionEntry,
  LatexCompletionItem,
  MacroCompletionEntry
} from '../vendor/latex-workshop/completion/types';
import { CompletionItemKind } from '../vendor/latex-workshop/completion/types';
import { lwSettingsProvider } from '../services/bootstrap';
import { projectIndex } from '../document/projectIndex';
import { argumentKind, completionRegistry, type CompletionContext, type CompletionEntry, type CompletionSource } from './completion';

/** Resolves the directory of a file path without pulling in `node:path`. */
function directoryOf(filePath: string): string {
  const separator = filePath.includes('\\') ? '\\' : '/';
  const index = filePath.lastIndexOf(separator);
  return index === -1 ? '' : filePath.slice(0, index);
}

/**
 * Project facts the providers read. Every accessor is answered from the project
 * index, which is kept current by the document analyzer.
 */
const projectState: CompletionProjectState = {
  labels(): LabelCompletionEntry[] {
    return projectIndex.getLabels().map((label) => ({
      name: label.name,
      file: label.file,
      line: label.line,
      text: label.section
    }));
  },

  citedKeys(): string[] {
    return projectIndex.getCitedKeys();
  },

  bibEntries(): CitationCompletionEntry[] {
    return projectIndex.getBibEntries().map((entry) => ({
      key: entry.key,
      type: entry.type,
      title: entry.title,
      authors: entry.authors,
      year: entry.year,
      journal: entry.journal,
      booktitle: entry.booktitle,
      doi: entry.doi,
      url: entry.url,
      source: entry.source,
      line: entry.line,
      fields: entry.fields
    }));
  },

  macros(): MacroCompletionEntry[] {
    return projectIndex.getMacros().map((macro) => ({
      name: macro.name.replace(/^\\/, ''),
      args: macro.args,
      file: macro.file,
      line: macro.line,
      definition: macro.definition
    }));
  },

  documentEnvironments(uri: string): string[] {
    const document = projectIndex.getDocument(uri);
    if (!document) return [];
    return [...new Set(document.getAnalysis().environments.map((environment) => environment.name))];
  },

  packages(uri: string): string[] {
    const document = projectIndex.getDocument(uri);
    if (!document) return [];
    const matches = document.getText().matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g);
    const names = new Set<string>();
    for (const match of matches) {
      for (const name of match[1].split(',').map((value) => value.trim()).filter(Boolean)) names.add(name);
    }
    return [...names];
  },

  documentClass(uri: string): string | undefined {
    const document = projectIndex.getDocument(uri);
    if (!document) return undefined;
    const match = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(document.getText());
    return match?.[1].trim() || undefined;
  },

  glossaryEntries() {
    // Glossary entries come from `\newglossaryentry` / `\newacronym`; Eukolia's
    // analyzer does not extract them yet, so this reports nothing rather than
    // inventing entries (Instructions.md §72).
    return [];
  },

  files(): FileCompletionEntry[] {
    return projectIndex
      .getFiles()
      .filter((file) => !file.isDirectory)
      .map((file) => ({
        path: file.path,
        name: file.name,
        relativePath: file.relativePath,
        isDirectory: false
      }));
  },

  graphicsPaths(uri: string): string[] {
    const document = projectIndex.getDocument(uri);
    const directories = new Set<string>();
    const projectRoot = projectIndex.getProjectRoot();
    if (projectRoot) directories.add(projectRoot);

    const text = document?.getText() ?? '';
    const match = /\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)*)\}/.exec(text);
    if (match) {
      const base = directoryOf(uri);
      for (const entry of match[1].matchAll(/\{([^}]*)\}/g)) {
        const value = entry[1].trim();
        if (!value) continue;
        directories.add(value.startsWith('/') || /^[a-zA-Z]:/.test(value) ? value : `${base}/${value.replace(/^\.\//, '')}`);
      }
    }
    return [...directories];
  },

  documentText(uri: string): string | undefined {
    return projectIndex.getDocument(uri)?.getText();
  },

  rootFile(): string | undefined {
    return projectIndex.getRootDocumentPath() ?? undefined;
  }
};

/** Maps a LaTeX Workshop item kind onto Eukolia's completion kinds. */
function mapKind(item: LatexCompletionItem, context: CompletionContext): CompletionEntry['kind'] {
  const argument = context.argument ? argumentKind(context.argument.name) : null;

  // The item's own `kind` decides, which is what it is for: it is what the
  // reference's providers set, and Eukolia's `latex.completion.*` settings are
  // per kind. The old code guessed from the item's `detail` text instead, which
  // typed every `\ref` / `\label` suggestion as a macro — `detail` is the
  // enclosing section's *title* — so `latex.completion.references` did not gate
  // them and they were offered with the function icon.
  switch (item.kind) {
    // VS Code's `Reference` is what the reference uses for references, for
    // citations *and* for glossary entries. Which one this is comes from the
    // command the caret is inside, and, when that names no argument, from the
    // BibTeX entry only the citation provider attaches.
    case CompletionItemKind.Reference:
      return argument === 'citation' || isCitation(item) ? 'citation' : 'reference';

    case CompletionItemKind.File:
    case CompletionItemKind.Folder:
      return 'file';

    case CompletionItemKind.Snippet:
      return 'snippet';

    case CompletionItemKind.Constant:
      return 'symbol';

    case CompletionItemKind.Text:
      return 'word';

    // Packaged macros, user macros and `@`-suggestions alike.
    case CompletionItemKind.Function:
      return 'macro';

    // `Module` covers environments, packages, classes and the `\end{...}`
    // closer. The item itself says when it is an environment; packages and
    // classes are told apart by the same command-in-context answer, because
    // `classnames.json` and `packagenames.json` both leave `detail` empty.
    case CompletionItemKind.Module:
      if (isEnvironment(item)) return 'environment';
      if (argument === 'package' || argument === 'class') return argument;
      return item.label.startsWith('\\') ? 'command' : 'macro';

    default:
      return item.label.startsWith('\\') ? 'command' : 'macro';
  }
}

/** The reference's `Module` items that are environments, closer included. */
function isEnvironment(item: LatexCompletionItem): boolean {
  return (
    item.label.startsWith('\\end{') ||
    item.detail?.includes('\\begin{') === true ||
    item.documentation?.startsWith('Environment ') === true
  );
}

/** Whether a `Reference` item carries a BibTeX entry, i.e. is a citation. */
function isCitation(item: LatexCompletionItem): boolean {
  return typeof item.data?.type === 'string';
}

/** Converts a ported item into Eukolia's editor-agnostic shape. */
function toEntry(item: LatexCompletionItem, source: string, context: CompletionContext): CompletionEntry {
  return {
    label: item.label,
    kind: mapKind(item, context),
    insertText: item.insertText ?? item.label,
    // The reference embeds `${1:...}` tab stops in `insertText`, which is
    // exactly the snippet syntax both editors use.
    insertTextFormat: /\$\{\d|\$\d/.test(item.insertText ?? item.label) ? 'snippet' : 'plain',
    detail: item.detail,
    documentation: typeof item.documentation === 'string' ? item.documentation : undefined,
    source,
    sortText: item.sortText,
    filterText: item.filterText,
    range: item.textEdit ? { from: offsetOf(item.textEdit.range, 'start'), to: offsetOf(item.textEdit.range, 'end') } : undefined
  };
}

/**
 * The ported providers build ranges on the cursor's own line, so the offsets are
 * recovered from the same line and character they were given.
 */
function offsetOf(range: { start: { line: number; character: number }; end: { line: number; character: number } }, edge: 'start' | 'end'): number {
  const position = edge === 'start' ? range.start : range.end;
  const lines = currentText.split('\n');
  let offset = 0;
  for (let line = 0; line < Math.min(position.line, lines.length); line++) offset += lines[line].length + 1;
  return offset + position.character;
}

/** The text of the document currently being completed; set per request. */
let currentText = '';

/**
 * Builds the LaTeX Workshop context for a Eukolia completion request.
 */
function toLwContext(context: CompletionContext): LwCompletionContext {
  currentText = context.text;
  return {
    args: {
      uri: context.uri,
      langId: context.languageId,
      line: context.lineText,
      // The reference works in 0-based columns; Eukolia reports 1-based.
      character: Math.max(0, context.column - 1),
      lineNumber: Math.max(0, context.lineNumber - 1),
      // A single cursor is assumed unless the editor tells us otherwise.
      selectionCount: 1,
      settings: lwSettingsProvider(context.uri)
    },
    project: projectState
  };
}

/**
 * The completion source. Registered with a high priority so LaTeX Workshop's
 * ranking (especially the citation ranker) wins over the generic fallbacks.
 */
export const latexWorkshopCompletionSource: CompletionSource = {
  id: 'latex-workshop',
  priority: 100,
  provide(context) {
    const lw = toLwContext(context);

    // `@` suggestions are a separate entry point in the reference.
    if (context.lineText.slice(0, context.column).includes('@')) {
      const suggestions = provideAtSuggestions(lw);
      if (suggestions.length > 0) return suggestions.map((item) => toEntry(item, 'latex-workshop', context));
    }

    const items = provideLatexCompletions(lw);
    return items.map((item) => toEntry(item, 'latex-workshop', context));
  }
};

/**
 * Provides a single completion category, used by tests and by any future
 * per-category setting.
 */
export function provideCategory(
  type: (typeof dispatchOrder)[number],
  context: CompletionContext
): LatexCompletionItem[] {
  return provideCompletionOfType(type, toLwContext(context));
}

let preloaded = false;

/**
 * Loads the package/environment datasets once.
 *
 * Until this resolves, the bundled defaults still answer, but package-aware
 * macros and environments are missing — so it runs during startup.
 */
export async function preloadLatexCompletionData(): Promise<void> {
  if (preloaded) return;
  const context: CompletionContext = {
    text: '',
    offset: 0,
    uri: '',
    languageId: 'latex',
    lineNumber: 1,
    column: 1,
    lineText: '',
    prefix: '',
    afterBackslash: false,
    argument: null,
    environment: null,
    inMath: false
  };
  await preloadCompletionData(toLwContext(context));
  preloaded = true;
}

let registered = false;

/** Registers the source with Eukolia's completion registry, once. */
export function registerLatexWorkshopCompletion(): void {
  if (registered) return;
  registered = true;
  completionRegistry.register(latexWorkshopCompletionSource);
  void preloadLatexCompletionData().catch((err) => {
    console.error('[eukolia] could not preload LaTeX completion data', err);
  });
}

export { dispatchOrder };
