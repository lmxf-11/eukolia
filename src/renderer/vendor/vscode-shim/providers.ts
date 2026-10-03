/**
 * Eukolia — VS Code compatibility layer: language feature provider registries.
 *
 * Ported extensions register completion / hover / folding / symbol providers
 * through `languages.register*`. Instead of dropping those registrations, the
 * shim keeps them in real registries that Eukolia's Monaco adapter queries.
 */

import type { Disposable } from './events';
import type { ShimTextDocument } from './position';
import type { Position, Range } from './position';
import type { CompletionItem, CompletionList, DocumentLink, FoldingRange, Hover, Location, SymbolInformation, TextEdit } from './language';

export interface CompletionContext {
  triggerKind: number;
  triggerCharacter?: string;
}

export interface CompletionItemProvider {
  provideCompletionItems(document: ShimTextDocument, position: Position, token: unknown, context: CompletionContext): unknown;
  resolveCompletionItem?(item: CompletionItem, token: unknown): unknown;
}

export interface HoverProvider {
  provideHover(document: ShimTextDocument, position: Position, token: unknown): unknown;
}

export interface FoldingRangeProvider {
  provideFoldingRanges(document: ShimTextDocument, context: unknown, token: unknown): unknown;
}

export interface DocumentSymbolProvider {
  provideDocumentSymbols(document: ShimTextDocument, token: unknown): unknown;
}

export interface DefinitionProvider {
  provideDefinition(document: ShimTextDocument, position: Position, token: unknown): unknown;
}

export interface ReferenceProvider {
  provideReferences(document: ShimTextDocument, position: Position, context: unknown, token: unknown): unknown;
}

export interface DocumentLinkProvider {
  provideDocumentLinks(document: ShimTextDocument, token: unknown): unknown;
}

export interface DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(document: ShimTextDocument, options: unknown, token: unknown): unknown;
}

export interface DocumentRangeFormattingEditProvider {
  provideDocumentRangeFormattingEdits(document: ShimTextDocument, range: Range, options: unknown, token: unknown): unknown;
}

export interface DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(document: ShimTextDocument, token: unknown): unknown;
}

interface Registration<T> {
  selector: string;
  provider: T;
  triggerCharacters?: string[];
}

function languageOf(selector: unknown): string {
  if (typeof selector === 'string') return selector;
  if (Array.isArray(selector)) return languageOf(selector[0]);
  if (selector && typeof selector === 'object' && 'language' in selector) {
    return String((selector as { language?: string }).language ?? '*');
  }
  return '*';
}

function makeRegistry<T>() {
  const items: Array<Registration<T>> = [];
  return {
    register(selector: unknown, provider: T, triggerCharacters?: string[]): Disposable {
      const registration: Registration<T> = { selector: languageOf(selector), provider, triggerCharacters };
      items.push(registration);
      return {
        dispose() {
          const index = items.indexOf(registration);
          if (index >= 0) items.splice(index, 1);
        }
      };
    },
    for(languageId: string): T[] {
      return items.filter((r) => r.selector === languageId || r.selector === '*').map((r) => r.provider);
    },
    triggerCharacters(languageId: string): string[] {
      const chars = new Set<string>();
      for (const r of items) {
        if (r.selector === languageId || r.selector === '*') {
          for (const ch of r.triggerCharacters ?? []) chars.add(ch);
        }
      }
      return [...chars];
    },
    all(): ReadonlyArray<Registration<T>> {
      return items;
    }
  };
}

export const completionProviders = makeRegistry<CompletionItemProvider>();
export const hoverProviders = makeRegistry<HoverProvider>();
export const foldingRangeProviders = makeRegistry<FoldingRangeProvider>();
export const documentSymbolProviders = makeRegistry<DocumentSymbolProvider>();
export const definitionProviders = makeRegistry<DefinitionProvider>();
export const referenceProviders = makeRegistry<ReferenceProvider>();
export const documentLinkProviders = makeRegistry<DocumentLinkProvider>();
export const documentFormattingProviders = makeRegistry<DocumentFormattingEditProvider>();
export const documentRangeFormattingProviders = makeRegistry<DocumentRangeFormattingEditProvider>();
export const semanticTokensProviders = makeRegistry<DocumentSemanticTokensProvider>();

/**
 * Call every registered provider and flatten the results, tolerating providers
 * that return `undefined` or throw. Ported code relies on this aggregation.
 */
export async function collect<T>(
  providers: ReadonlyArray<{ provide: (document: ShimTextDocument, ...rest: unknown[]) => unknown }>,
  document: ShimTextDocument,
  ...rest: unknown[]
): Promise<T[]> {
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const value = await provider.provide(document, ...rest);
        return value;
      } catch (err) {
        console.error('[eukolia] provider threw', err);
        return undefined;
      }
    })
  );

  const flat: T[] = [];
  for (const result of results) {
    if (!result) continue;
    if (Array.isArray(result)) flat.push(...(result as T[]));
    else if (typeof result === 'object' && 'items' in (result as object)) flat.push(...((result as CompletionList).items as T[]));
    else flat.push(result as T);
  }
  return flat;
}

export type { CompletionItem, CompletionList, Hover, FoldingRange, Location, SymbolInformation, TextEdit, DocumentLink };
