/**
 * Eukolia — LaTeX Workshop port: Unicode math symbol map.
 *
 * Ported from `getUnicodeMathSymbols`/`getUnicodeMathSymbol` of
 * `out/src/utils/parser.js` (LaTeX Workshop 10.19.0), which build their map from
 * `data/unimathsymbols.json`. Eukolia imports the same JSON from
 * `src/renderer/data/latex-workshop/unimathsymbols.json` (Instructions.md §8).
 *
 * The map serves three consumers:
 *  - the LaTeX parser, which renders a math macro as its Unicode glyph in labels
 *    and outline titles;
 *  - math symbol completion (`vendor/latex-workshop/completion/`), which needs
 *    `\command` -> glyph for its detail text;
 *  - the visual editor's symbol lookup, which searches by glyph or by name.
 */

import { unimathsymbols, type UnimathSymbol } from './completion/dataStore'

let commandToGlyph: Map<string, string> | undefined
let glyphToCommands: Map<string, UnimathSymbol[]> | undefined
let allSymbols: UnimathSymbol[] | undefined

/** The reference's map: command -> glyph, excluding entries that are themselves macros. */
export function getUnicodeMathSymbols(): Map<string, string> {
  if (commandToGlyph === undefined) {
    commandToGlyph = new Map(
      Object.values(unimathsymbols)
        .filter((symbol) => !symbol.detail.startsWith('\\'))
        .map((symbol) => [symbol.command, symbol.detail.split(' (')[0]])
    )
  }
  return commandToGlyph
}

/** `getUnicodeMathSymbol` of the reference, including the `up`-prefixed variant. */
export function getUnicodeMathSymbol(command: string): string | undefined {
  const symbols = getUnicodeMathSymbols()
  return symbols.get(command) ?? symbols.get(`up${command}`)
}

/** Every symbol entry, in file order. */
export function getUnimathSymbols(): UnimathSymbol[] {
  if (allSymbols === undefined) {
    allSymbols = Object.values(unimathsymbols)
  }
  return allSymbols
}

/**
 * Reverse lookup used by the visual editor's symbol picker: all `\commands`
 * whose glyph equals `glyph`.
 */
export function findUnimathCommands(glyph: string): UnimathSymbol[] {
  if (glyphToCommands === undefined) {
    glyphToCommands = new Map()
    for (const symbol of getUnimathSymbols()) {
      const key = symbol.detail.split(' (')[0]
      const list = glyphToCommands.get(key)
      if (list) {
        list.push(symbol)
      } else {
        glyphToCommands.set(key, [symbol])
      }
    }
  }
  return glyphToCommands.get(glyph) ?? []
}

/**
 * Search by `\command` prefix or by human-readable documentation, for the
 * visual editor's symbol lookup.
 */
export function searchUnimathSymbols(query: string, limit = 50): UnimathSymbol[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return []
  }
  const results: UnimathSymbol[] = []
  for (const symbol of getUnimathSymbols()) {
    if (
      symbol.command.toLowerCase().startsWith(needle) ||
      symbol.command.toLowerCase().includes(needle) ||
      symbol.documentation.toLowerCase().includes(needle)
    ) {
      results.push(symbol)
      if (results.length >= limit) {
        break
      }
    }
  }
  return results
}
