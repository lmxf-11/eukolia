/**
 * Eukolia — LaTeX Workshop port: glossary / acronym completion.
 *
 * Ported from `out/src/completion/completer/glossary.js` of LaTeX Workshop
 * 10.19.0: `provider.from`, `updateAll`'s two-map model (`glossaries` and
 * `acronyms`, and the `\ac...` macro picking only the acronym map) and the
 * regex path of `parseContent` with its three definition patterns.
 *
 * Adaptations required by the port:
 *  - the entries come from `CompletionProjectState.glossaryEntries()`, which
 *    carries `{ name, file, line }` and no type. The reference knows whether an
 *    entry is a glossary or an acronym because it parsed it. The document text
 *    is re-parsed here with the reference's own `parseContent` patterns to
 *    recover the type (and the description shown as `detail`); entries that the
 *    document does not define are offered for both macro families rather than
 *    dropped.
 */

import { CompletionItemKind, type CompletionContext, type LatexCompletionItem } from './types'

/** `GlossaryType` of the reference (`out/src/types.js`). */
export enum GlossaryType {
  glossary = 'glossary',
  acronym = 'acronym'
}

interface GlossaryEntryInfo {
  type: GlossaryType
  detail: string
}

function from(result: RegExpMatchArray, context: CompletionContext): LatexCompletionItem[] {
  return provide(context, result[1])
}

export const provider = { from }

function provide(context: CompletionContext, macroName: string | undefined): LatexCompletionItem[] {
  const types = classifyDocumentGlossary(context)
  const onlyAcronyms = macroName !== undefined && /^ac/i.test(macroName)
  const items: LatexCompletionItem[] = []
  for (const entry of context.project.glossaryEntries()) {
    const info = types.get(entry.name)
    // `\ac...` completes the acronym map only; every other glossary macro sees
    // the union of both maps.
    if (onlyAcronyms && info?.type === GlossaryType.glossary) {
      continue
    }
    items.push({
      label: entry.name,
      kind: CompletionItemKind.Reference,
      detail: info?.detail,
      data: { file: entry.file, line: entry.line, type: info?.type }
    })
  }
  return items
}

/**
 * Port of `glossary.parseContent`: the three definition patterns of the
 * reference, applied to the open document so the entries can be classified.
 */
function classifyDocumentGlossary(context: CompletionContext): Map<string, GlossaryEntryInfo> {
  const entries = new Map<string, GlossaryEntryInfo>()
  const content = context.project.documentText(context.args.uri)
  if (content === undefined) {
    return entries
  }
  // We assume that the label is always result[1] and use getDescription(result) for the description
  const regexes: Array<{ regex: RegExp; type: GlossaryType; getDescription: (result: RegExpExecArray) => string }> = [
    {
      regex: /\\(?:provide|new)glossaryentry{([^{}]*)}\s*{(?:(?!description).)*description=(?:([^{},]*)|{([^{}]*))[,}]/gms,
      type: GlossaryType.glossary,
      getDescription: (result) => (result[2] ? result[2] : result[3])
    },
    {
      regex: /\\long(?:provide|new)glossaryentry{([^{}]*)}\s*{[^{}]*}\s*{([^{}]*)}/gms,
      type: GlossaryType.glossary,
      getDescription: (result) => result[2]
    },
    {
      regex: /\\newacronym(?:\[[^[\]]*\])?{([^{}]*)}{[^{}]*}{([^{}]*)}/gm,
      type: GlossaryType.acronym,
      getDescription: (result) => result[2]
    }
  ]
  for (const { regex, type, getDescription } of regexes) {
    while (true) {
      const result = regex.exec(content)
      if (result === null) {
        break
      }
      entries.set(result[1], { type, detail: getDescription(result) })
    }
  }
  return entries
}

/** The reference's `glossary` namespace object (the cache/.bib parsing entry points are not part of the port). */
export const glossary = { provide }
