/**
 * Ported from References/overleaf-main/services/web/frontend/js/shared/hooks/use-dropdown.ts
 * Modified for Eukolia: `findDOMNode` was removed in React 19, so the hook keeps
 * a direct ref to the dropdown element instead of resolving it from a component
 * instance. Behaviour (open state, click-outside close, toggle handling) is
 * unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseDropdownResult {
  ref: (node: HTMLElement | null) => void
  onClick: (event: { stopPropagation(): void }) => void
  onToggle: (value: unknown) => void
  open: boolean
}

export default function useDropdown(defaultOpen = false): UseDropdownResult {
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLElement | null>(null)

  const handleRef = useCallback((node: HTMLElement | null) => {
    ref.current = node
  }, [])

  // prevent a click on the dropdown toggle propagating to the original handler
  const handleClick = useCallback((event: { stopPropagation(): void }) => {
    event.stopPropagation()
  }, [])

  const handleToggle = useCallback((value: unknown) => {
    setOpen(Boolean(value))
  }, [])

  const handleDocumentClick = useCallback((event: MouseEvent) => {
    if (ref.current && !ref.current.contains(event.target as Node)) {
      setOpen(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleDocumentClick)
    }
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick)
    }
  }, [open, handleDocumentClick])

  return { ref: handleRef, onClick: handleClick, onToggle: handleToggle, open }
}
