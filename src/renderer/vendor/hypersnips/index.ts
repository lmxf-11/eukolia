/**
 * Eukolia — HyperSnips snippet engine (port of `References/hypersnips/src`).
 *
 * This barrel only re-exports the ported implementation. The Eukolia-facing
 * facade lives in `src/renderer/snippets/`.
 *
 * Ported from References/hypersnips/src/* (MIT, (c) 2019 Ian Ornelas).
 * Modified for Eukolia.
 */

export {
  HSnippet,
  getSnippetBody,
  setSnippetBody,
  type GeneratorFunction,
  type GeneratorResult,
  type IHSnippetHeader
} from './hsnippet';

export { parse } from './parser';

export {
  HSnippetPart,
  HSnippetPartType,
  SnippetExpansion,
  readPlaceholder,
  replaceVisual,
  setSnippetHost,
  stripPlaceholders,
  type PlaceholderToken,
  type SnippetEditBuilder,
  type SnippetEditorLike,
  type SnippetExpansionOptions,
  type SnippetHost,
  type TextDocumentLike
} from './hsnippetInstance';

export { DynamicRange, GrowthType, type IChangeInfo } from './dynamicRange';

export {
  CompletionInfo,
  getCompletions,
  getMultiLineContext,
  setMultiLineContext,
  type GetCompletionsOptions
} from './completion';

export {
  getLineContext,
  getMultiLineContextText,
  getTriggerContext,
  isMathEnvironmentText,
  type ContextSnapshot
} from './contextDetector';

export {
  applyOffset,
  getSnippetDir,
  getWorkspaceUri,
  lineRange,
  setSnippetDirEnvironment,
  type SnippetDirEnvironment
} from './utils';

export { COMPLETIONS_TRIGGERS } from './consts';
