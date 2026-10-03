/**
 * Eukolia — LaTeX Workshop port: `.bib` file completion.
 *
 * Ported from `out/src/completion/bibtex.js` of LaTeX Workshop 10.19.0:
 * `BibProvider.entryToCompletion`, `fieldsToCompletion`,
 * `provideCompletionItems`, `provideOptFields` and `findFieldValues`, plus the
 * subset of `getBibtexFormatConfig` those two builders use (`tab`, `case.field`,
 * `left`, `right`).
 *
 * Adaptations required by the port:
 *  - the document and its position come from `CompletionArgs` and
 *    `CompletionProjectState.documentText(uri)` instead of the `vscode.TextDocument`
 *    (`document.getText(new Range(new Position(0, 0), position))` is rebuilt from
 *    the text's lines);
 *  - `bibtex-optional-entries.json` / `biblatex-optional-entries.json` are
 *    imported directly: `dataStore` only exposes the entry lists;
 *  - the reference re-reads its configuration on `onDidChangeConfiguration` and
 *    follows the active editor's workspace folder. Eukolia resolves the settings
 *    per request, so the provider is built per request — the data is 14 (bibtex)
 *    to 28 (biblatex) entry types, which makes that cheap.
 */

import biblatexOptionalEntriesJson from '../../../data/latex-workshop/biblatex-optional-entries.json'
import bibtexOptionalEntriesJson from '../../../data/latex-workshop/bibtex-optional-entries.json'

import { biblatexEntries, bibtexEntries } from './dataStore'
import { textPosition } from './completerUtils'
import { getLongestBalancedString } from '../utils/text'
import { settingOr, type LwSettings } from '../settings'
import { CompletionItemKind, type CompletionArgs, type CompletionContext, type LatexCompletionItem } from './types'

const bibtexOptionalEntries = bibtexOptionalEntriesJson as Record<string, string[]>
const biblatexOptionalEntries = biblatexOptionalEntriesJson as Record<string, string[]>

/** The fields of `bibtex-format.*` the completion builders read. */
interface BibtexFormatConfig {
  tab: string
  case: { field: string; type: string }
  left: string
  right: string
}

/** Read the indentation from the configuration (`bibtex-format.tab`). */
function getBibtexFormatTab(tab: string): string | undefined {
  if (tab === 'tab') {
    return '\t'
  }
  const res = /^(\d+)( spaces)?$/.exec(tab)
  if (res) {
    const nSpaces = parseInt(res[1], 10)
    return ' '.repeat(nSpaces)
  }
  return undefined
}

function getBibtexFormatConfig(settings: LwSettings): BibtexFormatConfig {
  const leftright = settingOr<string>(settings, 'bibtex-format.surround', 'Curly braces') === 'Curly braces' ? ['{', '}'] : ['"', '"']
  let tabs = getBibtexFormatTab(settingOr<string>(settings, 'bibtex-format.tab', '2 spaces'))
  if (tabs === undefined) {
    console.warn(`Wrong value for bibtex-format.tab: ${settingOr<string>(settings, 'bibtex-format.tab', '2 spaces')}`)
    console.warn("Setting bibtex-format.tab to '2 spaces'")
    tabs = '  '
  }
  return {
    tab: tabs,
    case: {
      field: settingOr<string>(settings, 'bibtex-format.case.field', 'lowercase'),
      type: settingOr<string>(settings, 'bibtex-format.case.type', 'lowercase')
    },
    left: leftright[0],
    right: leftright[1]
  }
}

export class BibProvider {
  private entryItems: LatexCompletionItem[] = []
  private optFieldItems: Record<string, LatexCompletionItem[]> = Object.create(null)
  private readonly formatConfig: BibtexFormatConfig

  constructor(settings: LwSettings) {
    this.formatConfig = getBibtexFormatConfig(settings)
    const citationBackend = settingOr<string>(settings, 'intellisense.citation.backend', 'bibtex')
    let entries: Record<string, string[]> = {}
    let optFields: Record<string, string[]> = {}
    let entriesReplacements: Record<string, string[]> = {}
    switch (citationBackend) {
      case 'bibtex':
        entries = bibtexEntries as Record<string, string[]>
        optFields = bibtexOptionalEntries
        entriesReplacements = settingOr<Record<string, string[]>>(settings, 'intellisense.bibtexJSON.replace', {})
        break
      case 'biblatex':
        entries = biblatexEntries as Record<string, string[]>
        optFields = biblatexOptionalEntries
        entriesReplacements = settingOr<Record<string, string[]>>(settings, 'intellisense.biblatexJSON.replace', {})
        break
      default:
        console.warn(`Unknown citation backend: ${citationBackend}`)
        return
    }
    this.loadDefaultItems(entries, optFields, entriesReplacements)
  }

  private loadDefaultItems(
    entries: Record<string, string[]>,
    optFields: Record<string, string[]>,
    entriesReplacements: Record<string, string[]>
  ): void {
    const entriesList: string[] = []
    this.entryItems = []
    Object.keys(entries).forEach((entry) => {
      if (entriesList.includes(entry)) {
        return
      }
      if (entry in entriesReplacements) {
        this.entryItems.push(this.entryToCompletion(entry, entriesReplacements[entry], this.formatConfig))
      } else {
        this.entryItems.push(this.entryToCompletion(entry, entries[entry], this.formatConfig))
      }
      entriesList.push(entry)
    })
    Object.entries(optFields).forEach(([field, item]) => {
      this.optFieldItems[field] = this.fieldsToCompletion(item, this.formatConfig)
    })
  }

  private entryToCompletion(itemName: string, itemFields: string[], config: BibtexFormatConfig): LatexCompletionItem {
    const suggestion: LatexCompletionItem = {
      label: itemName,
      kind: CompletionItemKind.Snippet,
      detail: itemName,
      documentation: `Add a @${itemName} entry`
    }
    let count = 1
    // The following code is copied from BibtexUtils.bibtexFormat
    // Find the longest field name in entry
    let s = itemName + '{${0:key}'
    itemFields.forEach((field) => {
      s += ',\n' + config.tab + (config.case.field === 'lowercase' ? field.toLowerCase() : field.toUpperCase())
      s += ' = '
      s += config.left + `$${count}` + config.right
      count++
    })
    s += '\n}'
    suggestion.insertText = s
    return suggestion
  }

  private fieldsToCompletion(fields: string[], config: BibtexFormatConfig): LatexCompletionItem[] {
    const suggestions: LatexCompletionItem[] = []
    fields.forEach((field) => {
      suggestions.push({
        label: field,
        kind: CompletionItemKind.Snippet,
        detail: field,
        documentation: `Add ${field} = ${config.left}${config.right}`,
        insertText: `${field} = ${config.left}$1${config.right},`
      })
    })
    return suggestions
  }

  provideCompletionItems(context: CompletionContext): LatexCompletionItem[] {
    const args: CompletionArgs = context.args
    const text = context.project.documentText(args.uri)
    if (text === undefined) {
      return []
    }
    const lines = text.split('\n')
    const lineNumber = textPosition(args).line
    const currentLine = lines[lineNumber] ?? args.line
    if (currentLine.match(/@[a-zA-Z]*$/)) {
      // Complete an entry name
      return this.entryItems
    } else if (currentLine.match(/^\s*[a-zA-Z]*$/)) {
      let offset = 0
      while (offset < 100) {
        const prevLine = lineNumber - offset > 0 ? lines[lineNumber - offset - 1] ?? '' : ''
        if (prevLine.match(/(?:@[a-zA-Z]{)|(?:["}0-9],\s*$)/)) {
          // Add optional fields
          return this.provideOptFields(lines, lineNumber, args)
        }
        offset += 1
      }
      return []
    }
    const result = currentLine.substring(0, args.character).match(/^\s*([a-zA-Z]*)\s*=\s*([{|"]?)$/)
    // If not found, or right before the starting { / "
    if (!result || (result[2] === '' && ['{', '"'].includes(currentLine.substring(args.character)[0]))) {
      return []
    }
    // Exclude the current editing field from searched
    const contentLines = [...lines]
    contentLines[lineNumber] = (contentLines[lineNumber] ?? '').replace(RegExp(`${result[1]}\\s*=\\s*`, 'g'), '')
    return findFieldValues(result[1], contentLines.join('\n'))
      .reduce<string[]>((unique, value) => {
        if (!unique.includes(value)) {
          unique.push(value)
        }
        return unique
      }, [])
      .map((entry) => ({ label: entry, kind: CompletionItemKind.Text }))
  }

  private provideOptFields(lines: string[], lineNumber: number, args: CompletionArgs): LatexCompletionItem[] {
    const pattern = /^\s*@([a-zA-Z]+)\{(?:[^,]*,)?\s$/m
    const content = [...lines.slice(0, lineNumber), (lines[lineNumber] ?? '').substring(0, args.character)].join('\n')
    const reversedContent = content.replace(/(\r\n)|\r/g, '\n').split('\n').reverse().join('\n')
    const match = reversedContent.match(pattern)
    if (match) {
      const entryType = match[1].toLowerCase()
      if (entryType in this.optFieldItems) {
        return this.optFieldItems[entryType]
      }
    }
    return []
  }
}

/** `findFieldValues` of `bibtex.js`. */
export function findFieldValues(field: string, text: string): string[] {
  const re = RegExp(`(${field}\\s*=\\s*)`, 'g')
  const candidates: string[] = []
  while (true) {
    const match = re.exec(text)
    if (!match) {
      break
    }
    const startPos = match.index + match[1].length
    if (text[startPos] === '{') {
      const candidate = getLongestBalancedString(text.slice(startPos))
      if (candidate !== undefined) {
        candidates.push(candidate)
      }
    } else if (text[startPos] === '"') {
      const quoteRe = /(?<!\\)"/g
      const quoteMatch = quoteRe.exec(text.slice(startPos + 1))
      if (quoteMatch) {
        candidates.push(text.slice(startPos + 1, startPos + quoteMatch.index + 1))
      }
    } else {
      const commaRe = /,/g
      const commaMatch = commaRe.exec(text.slice(startPos + 1))
      if (commaMatch) {
        candidates.push(text.slice(startPos, startPos + commaMatch.index + 1))
      }
    }
  }
  return candidates
}

/** Build a provider for one request and answer it — the reference's one provider per scope. */
export function provideBibtexCompletions(context: CompletionContext): LatexCompletionItem[] {
  return new BibProvider(context.args.settings).provideCompletionItems(context)
}
