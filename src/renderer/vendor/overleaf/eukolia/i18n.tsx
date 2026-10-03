/**
 * Eukolia substitution for the `react-i18next` usage inside the ported editor
 * components.
 *
 * Overleaf translates its editor UI with i18next keys such as
 * `sorry_your_table_cant_be_displayed_at_the_moment`. Eukolia keeps the same
 * call sites and the same key vocabulary, but resolves them from a plain
 * dictionary: the Eukolia phrase table when a key is present, otherwise the
 * key itself with underscores turned into spaces. Nothing is faked — an
 * untranslated string is shown as readable English rather than as a raw key.
 */

import { createContext, Fragment, useContext, type ReactNode } from 'react'

export type PhraseTable = Record<string, string>

const PhraseContext = createContext<PhraseTable>({})

export const I18nProvider = ({
  phrases,
  children,
}: {
  phrases: PhraseTable
  children: ReactNode
}): ReactNode => (
  <PhraseContext.Provider value={phrases}>{children}</PhraseContext.Provider>
)

/** Humanise an i18next key: `close_dialog` -> `Close dialog`. */
const humanise = (key: string): string => {
  const text = key.replace(/_/g, ' ').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function translate(
  key: string,
  phrases: PhraseTable,
  options?: Record<string, unknown>
): string {
  let value = phrases[key] ?? humanise(key)
  if (options) {
    for (const [name, replacement] of Object.entries(options)) {
      value = value.replace(new RegExp(`{{${name}}}`, 'g'), String(replacement))
    }
  }
  return value
}

export interface TranslationFn {
  (key: string, options?: Record<string, unknown>): string
}

/**
 * Drop-in replacement for i18next's hook: `const { t } = useTranslation()`.
 * The second argument (`ns`) is accepted and ignored, as Eukolia has one table.
 */
export function useTranslation(): {
  t: TranslationFn
  i18n: { language: string }
} {
  const phrases = useContext(PhraseContext)
  return {
    t: (key, options) => translate(key, phrases, options),
    i18n: { language: 'en' },
  }
}

/**
 * Replacement for i18next's `<Trans>`.
 *
 * The ported call sites pass `i18nKey` plus a `components` map such as
 * `{ b: <strong /> }`. The resolved phrase replaces each `<n>…</n>` placeholder
 * in the source string with the matching element, which is what i18next's
 * `Trans` does.
 */
export function Trans({
  i18nKey,
  defaults,
  components,
}: {
  i18nKey?: string
  defaults?: string
  components?: Record<string, ReactNode> | ReactNode[]
  [key: string]: unknown
}): ReactNode {
  const phrases = useContext(PhraseContext)
  const text = i18nKey ? translate(i18nKey, phrases) : (defaults ?? '')
  if (!components) return text

  // i18next accepts either an indexed map or a positional array of elements.
  const componentMap: Record<string, ReactNode> = Array.isArray(components)
    ? Object.fromEntries(components.map((item, i) => [String(i), item]))
    : components
  const names = Object.keys(componentMap)
  const parts: ReactNode[] = []
  const pattern = /<(\d+)>(.*?)<\/\1>/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const tag = names[Number(match[1])] ?? 'b'
    parts.push(<Fragment key={key++}>{componentMap[tag]}</Fragment>)
    parts.push(match[2])
    parts.push(<Fragment key={key++}>{componentMap[tag]}</Fragment>)
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return <>{parts}</>
}
