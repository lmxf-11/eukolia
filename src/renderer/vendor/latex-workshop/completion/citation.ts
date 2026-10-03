/**
 * Eukolia — LaTeX Workshop port: `\cite` completion.
 *
 * Ported from `out/src/completion/completer/citation.js` of LaTeX Workshop
 * 10.19.0: `provider.from`, `provide`, `provideFuzzy`, the `Fields` class with
 * its `join`, `readCitationFormat`, the `ids` field alternates, and the
 * label/filter-text/documentation construction. Ranking is
 * `citationRank.rankCitations`, ported verbatim.
 *
 * Adaptations required by the port:
 *  - the entries come from `CompletionProjectState.bibEntries()` (falling back
 *    to `citedKeys()`), which is what the reference's `updateAll` builds from
 *    the parsed `.bib` files and the `\bibitem`s of the included files. The
 *    declared `title`/`author`/`year`/... columns are folded into `fields` when
 *    the field is not already there, so the documentation block and the ranking
 *    see them;
 *  - `vscode.workspace.getConfiguration('latex-workshop')` becomes
 *    `CompletionArgs.settings`, and `vscode.Range`/`Position` become the plain
 *    range objects of `CompletionTextRange`;
 *  - the dispatcher's `browser` mode (a QuickPick) is exposed as data:
 *    `browserItems` returns exactly the entries the reference feeds to
 *    `showQuickPick`/`createQuickPick`, and the adapter owns the UI;
 *  - the reference's `parseBibFile`/`parseContent` (`.bib` parsing, `\bibitem`
 *    parsing) are the parser side of the extension and are not part of this
 *    port: the project state supplies the parsed entries;
 *  - "already cited in this file" filtering is added here (the brief for the
 *    port requires it): the keys of every complete citation macro in the open
 *    document are dropped from the suggestions;
 *  - `intellisense.citation.max.completion.items` no longer exists in LaTeX
 *    Workshop 10.19.0. It is honoured when the editor adapter provides it (> 0
 *    caps the list), and defaults to `0`, ie the reference's unlimited list.
 */

import { rankCitations } from './citationRank'
import { computeFilteringRange, textPosition, withTextEdit } from './completerUtils'
import { trimMultiLineString } from '../utils/text'
import { settingOr, type LwSettings } from '../settings'
import {
  CompletionItemKind,
  type CitationCompletionEntry,
  type CompletionContext,
  type CompletionTextRange,
  type LatexCompletionItem
} from './types'

/** Default of `intellisense.citation.format`, from the reference `package.json`. */
const defaultCitationFormat = ['author', 'title', 'journal', 'publisher', 'booktitle', 'year']

/** Default of `intellisense.citation.filterText`, from the reference `package.json`. */
const defaultCitationFilterText = ['bibtex key', 'title', 'other fields']

/**
 * Read the value `intellisense.citation.format`
 * @param excludedField A field to exclude from the list of citation fields. Primary usage is to not include `citation.label` twice.
 */
function readCitationFormat(settings: LwSettings, excludedField?: string): string[] {
  const fields = settingOr<string[]>(settings, 'intellisense.citation.format', defaultCitationFormat).map((f) =>
    f.toLowerCase()
  )
  if (excludedField) {
    return fields.filter((f) => f !== excludedField.toLowerCase())
  }
  return fields
}

/** The reference's `Fields`: the bib fields of one entry, in file order. */
export class Fields extends Map<string, string> {
  get author(): string | undefined {
    return this.get('author')
  }
  get journal(): string | undefined {
    return this.get('journal')
  }
  get journaltitle(): string | undefined {
    return this.get('journaltitle')
  }
  get title(): string | undefined {
    return this.get('title')
  }
  get publisher(): string | undefined {
    return this.get('publisher')
  }

  /**
   * Concatenate the values of the fields listed in `selectedFields`
   * @param selectedFields an array of field names
   * @param prefixWithKeys if true, every field is prefixed by 'Fieldname: '
   * @param joinString the string to use for joining the fields
   * @returns a string
   */
  join(selectedFields: string[], prefixWithKeys: boolean, joinString = ' '): string {
    const s: string[] = []
    for (const key of this.keys()) {
      if (selectedFields.includes(key)) {
        const value = this.get(key)
        if (prefixWithKeys) {
          s.push(key.charAt(0).toUpperCase() + key.slice(1) + ': ' + value)
        } else {
          s.push(value ?? '')
        }
      }
    }
    return s.join(joinString)
  }
}

export interface CitationSuggestion extends LatexCompletionItem {
  key: string
  fields: Fields
}

function from(_result: RegExpMatchArray, context: CompletionContext): LatexCompletionItem[] {
  return provide(context)
}

export const provider = { from }

function provide(context: CompletionContext): LatexCompletionItem[] {
  // Compile the suggestion array to vscode completion array
  const settings = context.args.settings
  const label = settingOr<string>(settings, 'intellisense.citation.label', 'bibtex key')
  const fields = readCitationFormat(settings)
  const range = computeFilteringRange(context.args.line, textPosition(context.args))
  const items = updateAll(context).filter((item) => !citedKeys(context).has(item.key))
  const alts: CitationSuggestion[] = []
  items.forEach((item) => {
    if (item.fields.has('ids')) {
      const ids = item.fields
        .get('ids')
        ?.split(',')
        .map((id) => id.trim())
      if (ids === undefined || ids.length === 0) {
        return
      }
      for (const id of ids) {
        const alt = Object.assign({}, item)
        alt.key = id
        alts.push(alt)
      }
    }
  })
  // Retrieve the list of fields to filter the completion items
  const filterContents = settingOr<string[]>(settings, 'intellisense.citation.filterText', defaultCitationFilterText)
  // Construct the filter text for each item
  const getFilterText = (item: CitationSuggestion): string => {
    const filterText = filterContents
      .map(
        (filterContent) =>
          ({
            'bibtex key': item.key,
            title: item.fields.get('title') || '',
            'other fields': item.fields.join(
              fields.filter((field) => field !== 'title'),
              false
            )
          })[filterContent] || ''
      )
      .filter((text) => text !== '')
      .join(' ')
    if (filterText === '') {
      return `${item.key} ${item.fields.get('title') || ''} ${item.fields.join(
        fields.filter((field) => field !== 'title'),
        false
      )}`
    }
    return filterText
  }
  const suggestions = [...items, ...alts].map((item) => {
    // Compile the completion item label
    switch (label) {
      case 'bibtex key':
      default:
        item.label = item.key
        break
      case 'title':
        if (item.fields.title) {
          item.label = item.fields.title
        }
        break
      case 'authors':
        if (item.fields.author) {
          item.label = item.fields.author
        }
        break
    }
    item.filterText = getFilterText(item)
    item.insertText = item.key
    withTextEdit(item, range)
    // Clear any ranking left on a cached entry by a previous fuzzy pass.
    item.sortText = undefined
    // We need two spaces to ensure md newline
    item.documentation = '\n' + item.fields.join(fields, true, '  \n') + '\n\n'
    return item
  })
  // Opt-in fuzzy ranking. VS Code applies its own filter/sort over the items we
  // return, so to make our order win we rank the entries ourselves, stamp each
  // with a zero-padded `sortText` (VS Code sorts lexicographically on it), and
  // set `filterText` to the raw query so VS Code's filter cannot drop a ranked
  // entry. The provider dispatcher wraps the result in an incomplete
  // `CompletionList` so VS Code re-queries — and we re-rank — on each keystroke.
  if (settingOr<boolean>(settings, 'intellisense.citation.fuzzy', true) && range) {
    return capSuggestions(provideFuzzy(context.args.line, range, suggestions, fields), settings)
  }
  return capSuggestions(suggestions, settings)
}

/**
 * `intellisense.citation.max.completion.items`: a legacy setting that LaTeX
 * Workshop 10.19.0 no longer declares. `0` (the fallback) keeps the reference's
 * unlimited list.
 */
function capSuggestions(suggestions: CitationSuggestion[], settings: LwSettings): CitationSuggestion[] {
  const maxItems = settingOr<number>(settings, 'intellisense.citation.max.completion.items', 0)
  if (typeof maxItems === 'number' && maxItems > 0 && suggestions.length > maxItems) {
    return suggestions.slice(0, maxItems)
  }
  return suggestions
}

function provideFuzzy(
  line: string,
  range: CompletionTextRange,
  suggestions: CitationSuggestion[],
  fields: string[]
): CitationSuggestion[] {
  const query = line.substring(range.start.character, range.end.character)
  if (query.trim().length > 0) {
    const ranked = rankCitations(suggestions, query, { format: fields })
    // On a zero-match keystroke fall back to the full list rather than an
    // empty one: the dispatcher only marks the completion list incomplete
    // while the citation provider returns entries, and a complete empty
    // list would stop VS Code from re-querying (so ranking would not
    // re-engage once a later edit matches again). VS Code's own filter
    // then applies to the unranked fallback.
    if (ranked.length === 0) {
      return suggestions
    }
    const width = Math.max(4, String(ranked.length).length)
    ranked.forEach((item, index) => {
      item.sortText = String(index).padStart(width, '0')
      item.filterText = query
    })
    return ranked
  }
  return suggestions
}

/**
 * The citation macro shape of the dispatcher regex, used to collect the keys
 * that are already cited in the open document.
 */
function citedKeys(context: CompletionContext): Set<string> {
  const keys = new Set<string>()
  const text = context.project.documentText(context.args.uri)
  if (text === undefined) {
    return keys
  }
  const reg =
    /\\(?:[a-zA-Z]*[Cc]ite[a-zA-Z]*\*?|bibentry)(?:\([^[)]*\)){0,2}(?:<[^<>]*>|\[[^[\]]*\]|{[^{}]*})*{([^}]*)}/g
  while (true) {
    const result = reg.exec(text)
    if (result === null) {
      break
    }
    for (const key of result[1].split(',')) {
      const trimmed = key.trim()
      if (trimmed !== '') {
        keys.add(trimmed)
      }
    }
  }
  return keys
}

/**
 * Returns the bib entries the project knows about: the `.bib` files' entries,
 * or — when the adapter has none — the keys cited in the project.
 */
function updateAll(context: CompletionContext): CitationSuggestion[] {
  const entries = context.project.bibEntries()
  if (entries.length === 0) {
    return context.project
      .citedKeys()
      .filter((key) => key !== '')
      .map((key) => ({ key, fields: new Fields(), label: key, kind: CompletionItemKind.Reference }))
  }
  return entries.map((entry) => {
    const fields = new Fields()
    for (const [name, value] of Object.entries(entry.fields ?? {})) {
      fields.set(name, value)
    }
    for (const [name, value] of typedFields(entry)) {
      if (!fields.has(name)) {
        fields.set(name, value)
      }
    }
    return {
      key: entry.key,
      label: entry.key,
      kind: CompletionItemKind.Reference,
      fields,
      detail: entry.title,
      data: { file: entry.source, line: entry.line, type: entry.type }
    }
  })
}

/** The declared columns of `CitationCompletionEntry`, as bib fields. */
function typedFields(entry: CitationCompletionEntry): Array<[string, string]> {
  const pairs: Array<[string, string | undefined]> = [
    ['author', entry.author],
    ['title', entry.title],
    ['year', entry.year],
    ['journal', entry.journal],
    ['booktitle', entry.booktitle],
    ['doi', entry.doi],
    ['url', entry.url]
  ]
  return pairs.filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== '')
}

/** One row of the reference's citation QuickPick. */
export interface BrowserCitationItem {
  label: string
  description: string
  detail: string
  alwaysShow?: boolean
}

/**
 * Port of `citation.browser`: exactly the data the reference feeds to
 * `vscode.window.showQuickPick`/`createQuickPick` (fuzzy ranking included, with
 * `alwaysShow` set so the QuickPick's own filter cannot drop a ranked entry),
 * with the QuickPick itself — its insertion edit and its key handling — left to
 * the editor adapter.
 */
export function browserItems(context: CompletionContext, query = ''): BrowserCitationItem[] {
  const settings = context.args.settings
  const label = settingOr<string>(settings, 'intellisense.citation.label', 'bibtex key')
  const fields = readCitationFormat(settings, label)
  const entries = updateAll(context).filter((item) => !citedKeys(context).has(item.key))
  const toItem = (item: CitationSuggestion): BrowserCitationItem => ({
    label: item.fields.title ? trimMultiLineString(item.fields.title) : '',
    description: item.key,
    detail: item.fields.join(fields, true, ', ')
  })
  if (settingOr<boolean>(settings, 'intellisense.citation.fuzzy', true)) {
    const rankFields = readCitationFormat(settings)
    const ranked = query.trim().length > 0 ? rankCitations(entries, query, { format: rankFields }) : entries
    return ranked.map((item) => ({ ...toItem(item), alwaysShow: true }))
  }
  return entries.map(toItem)
}

/**
 * The reference's `citation.getItem`: the raw entry of one key, used by the
 * citation hover.
 */
export function getItem(key: string, context: CompletionContext): CitationSuggestion | undefined {
  return updateAll(context).find((elm) => elm.key === key)
}
