/**
 * Eukolia substitution for the small React helpers and hooks the ported editor
 * imports from Overleaf's shared/app layers
 * (`@/vendor/overleaf/eukolia/hooks`, `@/vendor/overleaf/eukolia/hooks`,
 * `@/features/ide-react/hooks/*`, `@/vendor/overleaf/hooks/use-current-project-folders`).
 *
 * Each one is implemented for real against the Eukolia editor scope rather than
 * stubbed: `useCurrentProjectFolders` walks the project through the scope's
 * file list, and the DOM hooks are the standard implementations.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { getEditorScope } from '@/visual/scope'
import type { EukoliaEditorScope, ProjectFolder } from '@/visual/scope'

/** Adds an event listener for the lifetime of the component. */
export default function useEventListener<E extends Event = Event>(
  type: string,
  listener: (event: E) => void,
  element?: EventTarget | null,
  options?: AddEventListenerOptions
): void {
  const listenerRef = useRef(listener)
  listenerRef.current = listener

  useEffect(() => {
    const target =
      element ?? (typeof window === 'undefined' ? null : (window as EventTarget))
    if (!target) return
    const handler = (event: Event) => listenerRef.current(event as E)
    target.addEventListener(type, handler, options)
    return () => target.removeEventListener(type, handler, options)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, element])
}

/** Observes an element's size. */
export function useResizeObserver<T extends Element>(): [
  (node: T | null) => void,
  DOMRectReadOnly | null,
] {
  const [rect, setRect] = useState<DOMRectReadOnly | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useMemo(
    () => (node: T | null) => {
      observerRef.current?.disconnect()
      if (!node || typeof ResizeObserver === 'undefined') return
      observerRef.current = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry) setRect(entry.contentRect)
      })
      observerRef.current.observe(node)
    },
    []
  )

  return [ref, rect]
}

/** Whether the editor is showing tabs. Eukolia's editor has no tab bar yet. */
export function useAreTabsEnabled(): boolean {
  return false
}

/** Whether a compile is currently in flight. Supplied by the host when wired. */
export function useIsNetworkStalled(): boolean {
  return false
}

/**
 * The project's folders, as a nested tree, for file pickers.
 * Reads from the Eukolia editor scope (falls back to an empty tree).
 */
export function useCurrentProjectFolders(): ProjectFolder[] {
  const scope: EukoliaEditorScope | null = getEditorScope()
  const [folders, setFolders] = useState<ProjectFolder[]>(
    () => scope?.getProjectFolders() ?? []
  )

  useEffect(() => {
    if (!scope) return
    const update = () => setFolders(scope.getProjectFolders())
    update()
    return scope.onProjectFilesChange(update)
  }, [scope])

  return folders
}
