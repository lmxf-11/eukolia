/**
 * Eukolia substitution for `react-error-boundary`, which the table generator
 * uses to keep a broken table from taking down the editor.
 *
 * This is a real error boundary (the API surface `react-error-boundary` exposes
 * for the ported call sites), not a no-op.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface FallbackProps {
  error: Error
  resetErrorBoundary: () => void
}

export interface ErrorBoundaryProps {
  children?: ReactNode
  FallbackComponent?: (props: FallbackProps) => ReactNode
  fallbackRender?: (props: FallbackProps) => ReactNode
  fallback?: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
  onReset?: () => void
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
  }

  resetErrorBoundary = (): void => {
    this.props.onReset?.()
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error) {
      const props: FallbackProps = {
        error,
        resetErrorBoundary: this.resetErrorBoundary,
      }
      if (this.props.FallbackComponent) return this.props.FallbackComponent(props)
      if (this.props.fallbackRender) return this.props.fallbackRender(props)
      return this.props.fallback ?? null
    }
    return this.props.children
  }
}

/** Convenience wrapper matching `react-error-boundary`'s functional form. */
export function withErrorBoundary<P extends object>(
  Component_: React.ComponentType<P>,
  boundaryProps: Omit<ErrorBoundaryProps, 'children'>
): React.ComponentType<P> {
  const Wrapped = (props: P): ReactNode => (
    <ErrorBoundary {...boundaryProps}>
      <Component_ {...props} />
    </ErrorBoundary>
  )
  Wrapped.displayName = `withErrorBoundary(${Component_.displayName ?? Component_.name ?? 'Component'})`
  return Wrapped
}
