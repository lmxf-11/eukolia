/**
 * Eukolia — snippet system barrel.
 *
 * The engine itself is the HyperSnips port in `src/renderer/vendor/hypersnips/`;
 * these modules are the Eukolia-facing facade, context provider and editor
 * adapter.
 */

export {
  SnippetEngine,
  getSnippetEngine,
  setSnippetEngine,
  offsetFromPosition,
  positionFromOffset,
  stripPlaceholders,
  type AutomaticExpansionResult,
  type ExpandOptions,
  type ExpansionGeometry,
  type PlaceholderLocation,
  type ResolvedVariables,
  type SelectionSnapshot,
  type SnippetCompletionContext,
  type SnippetDocumentChange,
  type SnippetExpansionCandidate,
  type SnippetSource,
  type VariableResolver
} from './engine';

export type { CompletionInfo, DocumentLike, HSnippet, SnippetEditBuilder, SnippetExpansion } from './engine';

export { createStringDocument, createTextDocumentAdapter, type EditTargetLike } from './documentAdapter';

export {
  getContextProvider,
  setContextProvider,
  snippetContextAllows,
  TextContextDetector,
  TextContextProvider,
  TextViewContextDetector,
  type ContextDetector,
  type ContextDetectorInput,
  type ContextDocument,
  type ContextProvider,
  type LatexContext
} from './context';

export {
  SnippetEditorAdapter,
  type AppliedExpansion,
  type SnippetAdapterOptions,
  type SnippetEditorPort,
  type TabStopMove
} from './editorAdapter';

export {
  DEFAULT_LATEX_SNIPPETS_FILE,
  defaultSnippetSources,
  defaultSnippets,
  defaultSnippetsSource,
  type SnippetLibraryEntry
} from './defaultSnippets';

export {
  SnippetStore,
  createSnippetStoreServices,
  getSnippetStore,
  setSnippetStore,
  readProjectSnippetSources,
  type SnippetFileReading,
  type SnippetStoreServices,
  type SnippetStoreState
} from './store';
