/**
 * Eukolia service instances.
 *
 * The workspace service needs the ported LaTeX analyzer, the BibTeX parser and
 * root-document detection. Those are wired here rather than in `bootstrap.ts` so
 * that modules can import the instance without an import cycle.
 *
 * The analyzer is the one member that is *not* imported here. It drags the whole
 * ported LaTeX Workshop parser behind it — unified-latex, latex-utensils and
 * prettier, 1.5 MB of the entry bundle and a fifth of its evaluation time — and a
 * window that is opening with no document on screen does not need to know what a
 * section is. `loadDocumentAnalyzer` is a dynamic import for exactly that reason;
 * `WorkspaceService` installs it as soon as it resolves and works without it
 * until then (`DocumentModel` treats a null analyzer as "nothing analysed yet").
 */

import { WorkspaceService } from './workspace';
import { resolveRelative } from './resolveRelative';
import { parseBibtex, type ProjectBibEntry } from '../parser/bibParser';
import type { BibEntry } from '../document/projectIndex';
import type { DocumentAnalyzer } from '../document/documentModel';
import { findMagicComments } from '../vendor/latex-workshop/compile/recipe';

/**
 * Loads the LaTeX analyzer.
 *
 * Idempotent — the module is a singleton once the dynamic import has resolved, so
 * every caller gets the same instance. The `import()` is of a module that is only
 * ever reached through this function, which is what keeps it and everything it
 * imports out of the entry chunk.
 */
let analyzerPromise: Promise<DocumentAnalyzer> | null = null;
export function loadDocumentAnalyzer(): Promise<DocumentAnalyzer> {
  analyzerPromise ??= import('../parser/latexAnalyzer').then((module) => module.latexDocumentAnalyzer);
  return analyzerPromise;
}

/** The analyzer, if it has already been loaded. Never triggers a load. */
let loadedAnalyzer: DocumentAnalyzer | null = null;
export function documentAnalyzerIfLoaded(): DocumentAnalyzer | null {
  return loadedAnalyzer;
}

export const workspaceService = new WorkspaceService({
  async createAnalyzer(): Promise<DocumentAnalyzer | null> {
    return loadDocumentAnalyzer();
  },
  onAnalyzerLoaded(analyzer) {
    loadedAnalyzer = analyzer;
  },

  /**
   * The analysis channel, when this window has one.
   *
   * Resolved once, at wiring time, rather than per call: the preload script runs
   * before any renderer module, so whether the bridge is there is a fact about the
   * window rather than about the moment. A window without it — a settings or
   * snippets window, a test double — leaves this undefined and the project index
   * falls back to analysing on this thread, saying so once.
   */
  analyzeDocument:
    typeof window !== 'undefined' && typeof window.eukoliaApi?.analyzeDocument === 'function'
      ? (text: string, uri: string) => window.eukoliaApi.analyzeDocument(text, uri)
      : undefined,

  parseBibtex(content: string, sourcePath: string): BibEntry[] {
    const entries: ProjectBibEntry[] = parseBibtex(content, sourcePath);
    return entries.map((entry) => ({
      key: entry.key,
      type: entry.type,
      fields: entry.fields,
      title: entry.title,
      authors: entry.authors,
      year: entry.year,
      journal: entry.journal,
      booktitle: entry.booktitle,
      doi: entry.doi,
      url: entry.url,
      source: entry.source || sourcePath,
      line: entry.line
    }));
  },

  detectRootDocument: (files, contents) => detectRootDocumentSync(files, contents)
});

/**
 * Root detection.
 *
 * Magic comments are read with the ported LaTeX Workshop parser (synchronously,
 * from the prefix already in `contents`); everything else follows the reference's
 * rule — a file that declares `\documentclass` and is not included by any other
 * file is the root.
 */
export function detectRootDocumentSync(
  files: Array<{ path: string; name: string; isDirectory: boolean }>,
  contents: Map<string, string>
): string | null {
  const texFiles = files.filter((file) => !file.isDirectory && /\.(tex|ltx)$/i.test(file.name));
  if (texFiles.length === 0) return null;

  // 1. Magic comments: `% !TeX root = ../main.tex`
  for (const file of texFiles) {
    const content = contents.get(file.path);
    if (!content) continue;
    const match = /^\s*%\s*!\s*T[Ee]X\s+root\s*=\s*([^\s%]+)/m.exec(content);
    if (!match) continue;
    const resolved = resolveRelative(file.path, match[1]);
    if (contents.has(resolved) || texFiles.some((candidate) => samePath(candidate.path, resolved))) {
      return texFiles.find((candidate) => samePath(candidate.path, resolved))?.path ?? resolved;
    }
  }

  // 2. Files declaring \documentclass that nothing else \inputs.
  const withDocumentClass = new Set<string>();
  const included = new Set<string>();

  for (const file of texFiles) {
    const content = contents.get(file.path);
    if (!content) continue;
    if (/\\documentclass\b/.test(content)) withDocumentClass.add(file.path);

    const regexp = /\\(?:input|include|subfile|import|subimport|includeonly)\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = regexp.exec(content)) !== null) {
      for (const part of match[1].split(',').map((value) => value.trim()).filter(Boolean)) {
        included.add(resolveRelative(file.path, part).toLowerCase());
      }
    }
  }

  const roots = [...withDocumentClass].filter((file) => !included.has(file.toLowerCase()));
  if (roots.length === 1) return roots[0];
  if (roots.length > 1) return pickPreferred(roots);
  if (withDocumentClass.size === 1) return [...withDocumentClass][0];

  // 3. Nothing declares a document class: fall back to the conventional names,
  //    then to the first TeX file.
  return pickPreferred(texFiles.map((file) => file.path));
}

function pickPreferred(paths: readonly string[]): string {
  const preferred = ['main.tex', 'master.tex', 'root.tex', 'thesis.tex', 'paper.tex', 'document.tex', 'index.tex'];
  for (const name of preferred) {
    const match = paths.find((file) => file.replace(/^.*[\\/]/, '').toLowerCase() === name);
    if (match) return match;
  }
  return paths[0];
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/** Resolves a LaTeX-relative path, adding a `.tex` extension when absent. */
export { resolveRelative } from './resolveRelative';
