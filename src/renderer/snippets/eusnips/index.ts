/**
 * Eukolia — EUSnips.
 *
 * The snippet *file format* and everything derived from it, split so each piece
 * can be read on its own:
 *
 *  * `schema.json` / `validate.ts` — what a valid file is, and where a bad one
 *    went wrong (down to the line, via `jsonSource.ts`);
 *  * `model.ts` — the file's TypeScript shape, defaults resolution, and the
 *    stable on-disk serialisation;
 *  * `body.ts` — the snippet body in both of its forms;
 *  * `hsnips.ts` — the projection onto the ported HyperSnips engine;
 *  * `seed.ts` — the first-run library and the `.hsnips` migration.
 *
 * Nothing here touches the filesystem, Electron or React: it is all pure, and
 * that is what `tests/snippets/eusnips.test.ts` exercises.
 */

export {
  EUSNIPS_SCHEMA,
  validateSnippetFile,
  formatValidationIssues,
  checkRegexTrigger,
  type ValidationIssue,
  type ValidationResult
} from './validate';

export {
  offsetOfJsonPointer,
  offsetsOfJsonPointers,
  positionOfOffset,
  type JsonPosition
} from './jsonSource';

export {
  FIELD_LABELS,
  describeSemanticIssues,
  describeValidationIssues,
  fieldOfMessage,
  fieldOfPointer,
  indexProblemCounts,
  isEmptyTriggerProblem,
  problemLines,
  problemTooltip,
  propertyOfPointer,
  snippetAsStored,
  snippetIndexOfPointer,
  snippetProblems,
  type SnippetField,
  type SnippetProblem
} from './problems';

export {
  DEFAULT_BOUNDARY,
  DEFAULT_LANGUAGE,
  DEFAULT_PRIORITY,
  EUSNIPS_VERSION,
  SNIPPET_ID_ALPHABET,
  SNIPPET_ID_LENGTH,
  assignMissingSnippetIds,
  buildTrigger,
  checkWritableDocument,
  createSnippet,
  duplicateSnippet,
  effectiveSnippet,
  emptySnippetFile,
  engineContext,
  escapeRegexText,
  escapeRegexTrigger,
  fileLanguage,
  isEmptySnippet,
  isEmptyTriggerIssue,
  languageDisagreement,
  nextDuplicateSnippetId,
  nextSnippetId,
  normalizeSnippetFile,
  parseSnippetFileText,
  randomSnippetId,
  serializeSnippetFile,
  withoutInlineGlobals,
  snippetBodyLines,
  snippetIds,
  splitTrigger,
  uniqueSnippetId,
  upgradeSnippetFile,
  type EffectiveSnippet,
  type EusnipsContextExpression,
  type EusnipsDefaults,
  type EusnipsFile,
  type EusnipsIssue,
  type EusnipsSnippet,
  type EusnipsTrigger,
  type NormalizedSnippetFile,
  type ParsedSnippetFile,
  type TriggerParts,
  type WritableDocumentCheck
} from './model';

export {
  bodyLines,
  bodySubstitutions,
  codeBlock,
  expressionText,
  isSourceBody,
  parseSubstitution,
  renderBody,
  selectionText,
  substitutionText,
  tabstopIndices,
  tabstopText,
  tokenizeBody,
  tokenizeStructured,
  type BodyNode,
  type BodySubstitution,
  type ExpressionBodyNode,
  type JavascriptBodyNode,
  type SelectionBodyNode,
  type SnippetBody,
  type TabstopBodyNode,
  type TextBodyNode
} from './body';

export {
  EUSNIPS_SOURCE_PREFIX,
  anchorPattern,
  applyBehaviour,
  applyRegexFlags,
  globalsBlock,
  globalsSource,
  isEmptyBody,
  loadEusnipsIntoEngine,
  renderSnippetDocument,
  renderSnippetSources,
  sourceNameFor,
  unescapeHeaderTrigger,
  type LoadedSnippet,
  type RenderedSnippet
} from './hsnips';

export {
  builtInSnippets,
  changedImports,
  hashContent,
  hsnipsBodySource,
  idForSnippet,
  importReceipts,
  initialSnippetFile,
  migrateInto,
  parseSnippetBodies,
  pendingImports,
  priorityHints,
  removeImported,
  snippetFromParsed,
  type ImportReceipt,
  type MigrationResult,
  type MigrationSource
} from './seed';
