/**
 * Eukolia substitution for Overleaf's split-test context
 * (`@/vendor/overleaf/eukolia/split-test`, `@/vendor/overleaf/eukolia/split-test`).
 *
 * Overleaf gates editor features behind server-assigned A/B variants. Eukolia
 * ships one behaviour, so every flag resolves to the Eukolia default rather
 * than to a random variant — a component asking "is this feature on?" gets the
 * real answer for this application.
 */
import { createContext, useContext, type ReactNode } from 'react'

export type Variant = 'default' | 'enabled' | 'disabled'

export type SplitTestFlags = Record<string, Variant>

/** Feature flags and their Eukolia behaviour. */
export const EUKOLIA_SPLIT_TESTS: Record<string, Variant> = {
  'editor-tabs': 'disabled',
  'table-generator': 'enabled',
  'figure-modal': 'enabled',
  'math-preview': 'enabled',
  'paste-html': 'enabled',
}

const SplitTestContext = createContext<SplitTestFlags>(EUKOLIA_SPLIT_TESTS)

export const SplitTestProvider = ({
  value,
  children,
}: {
  value?: SplitTestFlags
  children: ReactNode
}): ReactNode => (
  <SplitTestContext.Provider value={value ?? EUKOLIA_SPLIT_TESTS}>
    {children}
  </SplitTestContext.Provider>
)

export function useFeatureFlag(name: string): boolean {
  const flags = useContext(SplitTestContext)
  const variant = flags[name] ?? EUKOLIA_SPLIT_TESTS[name] ?? 'disabled'
  return variant === 'enabled'
}

/** Non-hook accessor, for code that is not a component. */
export function getFeatureFlag(name: string): boolean {
  return (EUKOLIA_SPLIT_TESTS[name] ?? 'disabled') === 'enabled'
}
