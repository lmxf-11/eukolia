/**
 * BibTeX parsing for Eukolia.
 *
 * The citation metadata Eukolia needs (key, entry type, fields, title/authors/
 * year for the completion detail and the citations explorer) is produced by this
 * parser. LaTeX Workshop derives the same information from `latex-utensils`
 * inside its bundled worker (`out/src/parse/parser/unified.js`), which is not
 * reachable from the vendored bundle's exports — the ported macro/environment
 * parsing is used everywhere else, and this parser covers the bibliography.
 *
 * `parseBibtex` returns `projectIndex`'s `BibEntry` shape; `parseBibTeX` keeps
 * the original Eukolia surface used by the existing tests.
 */

export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  raw: string;
  line: number;
}

/** The shape `projectIndex.registerBibEntries()` expects. */
export interface ProjectBibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  title?: string;
  authors?: string[];
  year?: string;
  journal?: string;
  booktitle?: string;
  doi?: string;
  url?: string;
  source: string;
  line: number;
}

const ENTRY_REGEX = /@([a-zA-Z]+)\s*[{(]\s*([^,\s}]+)\s*,/g
const FIELD_REGEX = /([a-zA-Z_-]+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)"|(\d+))/g

/** Strip TeX escapes such as `{\"o}` and outer braces from a field value. */
function cleanValue(value: string): string {
  return value
    .replace(/[{}]/g, '')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split a BibTeX name list on top-level `and`, as BibTeX does. */
function splitAuthors(value: string): string[] {
  return value
    .split(/\s+and\s+/i)
    .map((author) => cleanValue(author))
    .filter((author) => author.length > 0)
}

export function parseBibTeX(content: string): BibEntry[] {
  const entries: BibEntry[] = []
  ENTRY_REGEX.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = ENTRY_REGEX.exec(content)) !== null) {
    const entryType = match[1].toLowerCase()
    const key = match[2].trim()
    const startIndex = match.index

    // Count line number
    const line = content.substring(0, startIndex).split(/\r?\n/).length

    // Find the closing brace matching this entry
    let braceCount = 1
    let curr = match.index + match[0].length
    let inQuotes = false

    while (curr < content.length && braceCount > 0) {
      const char = content[curr]
      if (char === '"' && content[curr - 1] !== '\\') {
        inQuotes = !inQuotes
      } else if (!inQuotes) {
        if (char === '{') braceCount++
        else if (char === '}') braceCount--
      }
      curr++
    }

    const raw = content.substring(startIndex, curr)
    const body = content.substring(startIndex + match[0].length, curr)

    const fields: Record<string, string> = {}
    FIELD_REGEX.lastIndex = 0
    let fieldMatch: RegExpExecArray | null
    while ((fieldMatch = FIELD_REGEX.exec(body)) !== null) {
      const fieldName = fieldMatch[1].toLowerCase()
      const value = fieldMatch[2] ?? fieldMatch[3] ?? fieldMatch[4] ?? ''
      fields[fieldName] = cleanValue(value)
    }

    entries.push({ key, type: entryType, fields, raw, line })
  }

  return entries
}

/**
 * `projectIndex.registerBibEntries()` shape: the same entries enriched with the
 * display metadata the completion list and the citations explorer show.
 */
export function parseBibtex(content: string, sourcePath: string): ProjectBibEntry[] {
  return parseBibTeX(content).map((entry) => {
    const authors = entry.fields['author'] ? splitAuthors(entry.fields['author']) : undefined
    const result: ProjectBibEntry = {
      key: entry.key,
      type: entry.type,
      fields: entry.fields,
      source: sourcePath,
      line: entry.line
    }
    if (entry.fields['title']) result.title = entry.fields['title']
    if (authors && authors.length > 0) result.authors = authors
    if (entry.fields['year']) result.year = entry.fields['year']
    else if (entry.fields['date']) result.year = entry.fields['date'].slice(0, 4)
    if (entry.fields['journal']) result.journal = entry.fields['journal']
    if (entry.fields['journaltitle']) result.journal = entry.fields['journaltitle']
    if (entry.fields['booktitle']) result.booktitle = entry.fields['booktitle']
    if (entry.fields['doi']) result.doi = entry.fields['doi']
    if (entry.fields['url']) result.url = entry.fields['url']
    return result
  })
}

/** Entry types of `bibtex-entries.json` / `biblatex-entries.json`, for completion. */
export function bibEntryTypes(entries: Record<string, string[]>): string[] {
  return Object.keys(entries).sort()
}
