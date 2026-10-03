/**
 * Eukolia substitution for Overleaf's Bootstrap wrapper components
 * (`@/shared/components/ol/*`).
 *
 * Overleaf builds its editor chrome on `react-bootstrap`. Eukolia does not
 * depend on react-bootstrap, so each wrapper is reimplemented over plain DOM
 * elements while keeping (a) the same import path shape, (b) the same default
 * export, and (c) the same Bootstrap class names, so the ported Overleaf
 * components render and behave the same and Eukolia's stylesheet can theme
 * them. Modals, popovers, tooltips and overlays are implemented for real —
 * portals, backdrops, Escape handling, click-outside and positioning — rather
 * than being decorative no-ops.
 *
 * Shared helpers live here; every `ol-*` module re-exports from this file.
 */
import {
  cloneElement,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import classNames from '../classnames'

/**
 * Props are forwarded to the underlying element; unknown props are allowed so
 * the ported call sites can pass through Bootstrap-specific attributes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type LooseProps = {
  children?: ReactNode
  className?: string
  style?: CSSProperties
  id?: string
  variant?: string
  size?: string
  disabled?: boolean
  active?: boolean
  as?: any
  role?: string
  onClick?: (event: React.MouseEvent<HTMLElement>) => void
  [key: string]: any
}

/** Splits a loose props bag into `class`/`style`/`children` and the rest. */
export function splitProps(
  props: LooseProps,
  baseClass: string,
  extraClass?: string
): {
  className: string
  children: ReactNode
  rest: Record<string, unknown>
} {
  const { className, children, variant, ...rest } = props
  void variant
  return {
    className: classNames(baseClass, extraClass, className),
    children,
    rest,
  }
}

/** Renders a portal into `document.body`, or inline when there is no DOM. */
export function Portal({ children }: { children: ReactNode }): ReactNode {
  if (typeof document === 'undefined') return children
  return createPortal(children, document.body)
}

/** Calls every provided handler in order. */
export function callFnsInSequence<T extends unknown[]>(
  ...fns: Array<((...args: T) => void) | undefined>
): (...args: T) => void {
  return (...args: T) => {
    for (const fn of fns) fn?.(...args)
  }
}

/** Tracks whether the pointer is currently outside the returned ref. */
export function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void
): void {
  useEffect(() => {
    if (!active) return
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onOutside()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [active, onOutside, ref])
}

/** Escape-key handling for dialogs and popovers. */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation()
        onEscape()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [active, onEscape])
}

/* --------------------------------------------------------------------- Button */

export type OLButtonProps = LooseProps & {
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  isLoading?: boolean
  loadingLabel?: string
  type?: 'button' | 'submit' | 'reset'
}

export const OLButton = forwardRef<HTMLButtonElement, OLButtonProps>(
  (
    {
      children,
      className,
      leadingIcon,
      trailingIcon,
      isLoading = false,
      loadingLabel,
      variant = 'primary',
      disabled,
      type = 'button',
      ...rest
    },
    ref
  ): ReactElement => (
    <button
      ref={ref}
      type={type}
      disabled={isLoading || disabled}
      data-ol-loading={isLoading}
      className={classNames(
        'btn',
        `btn-${variant}`,
        'd-inline-grid',
        { 'button-loading': isLoading },
        className
      )}
      {...rest}
    >
      {isLoading && (
        <span className="spinner-container">
          <span className="spinner-border spinner-border-sm" aria-hidden="true" />
          <span className="visually-hidden">{loadingLabel ?? 'Loading'}</span>
        </span>
      )}
      <span className="button-content" aria-hidden={isLoading}>
        {leadingIcon}
        {children}
        {trailingIcon}
      </span>
    </button>
  )
)
OLButton.displayName = 'OLButton'

/* -------------------------------------------------------------------- Tooltip */

export type OLTooltipProps = {
  id: string
  description: ReactNode
  children: ReactElement
  tooltipProps?: Record<string, unknown>
  overlayProps?: {
    placement?: string
    trigger?: string
    delay?: number | { show: number; hide: number }
  }
  hidden?: boolean
}

const DEFAULT_DELAY_SHOW = 300
const DEFAULT_DELAY_HIDE = 290

export function OLTooltip({
  id,
  description,
  children,
  overlayProps,
  hidden,
}: OLTooltipProps): ReactElement {
  const [show, setShow] = useState(false)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)

  const delay = overlayProps?.delay
  const delayShow = delay === undefined
    ? DEFAULT_DELAY_SHOW
    : typeof delay === 'number'
      ? delay
      : delay.show
  const delayHide = delay === undefined
    ? DEFAULT_DELAY_HIDE
    : typeof delay === 'number'
      ? Math.max(delay - 10, 0)
      : delay.hide

  const cancelTimers = useCallback(() => {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
  }, [])

  useEffect(() => {
    if (hidden) setShow(false)
  }, [hidden])

  useEffect(() => cancelTimers, [cancelTimers])

  useEscapeKey(show, () => setShow(false))

  if (hidden) return children

  const triggerProps =
    overlayProps?.trigger === 'click'
      ? {
          onClick: callFnsInSequence(
            (children.props as { onClick?: () => void }).onClick,
            () => setShow(value => !value)
          ),
        }
      : {
          onMouseEnter: () => {
            window.clearTimeout(hideTimer.current)
            showTimer.current = window.setTimeout(() => setShow(true), delayShow)
          },
          onMouseLeave: () => {
            window.clearTimeout(showTimer.current)
            hideTimer.current = window.setTimeout(() => setShow(false), delayHide)
          },
          onFocus: () => setShow(true),
          onBlur: () => setShow(false),
        }

  return (
    <>
      {cloneElement(
        children as ReactElement<Record<string, unknown>>,
        triggerProps
      )}
      {show &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            id={`${id}-tooltip`}
            role="tooltip"
            className={classNames(
              'tooltip',
              `bs-tooltip-${overlayProps?.placement ?? 'top'}`,
              'show'
            )}
          >
            <div className="tooltip-inner">{description}</div>
          </div>,
          document.body
        )}
    </>
  )
}

/* --------------------------------------------------------------------- Modal */

export type OLModalProps = LooseProps & {
  show?: boolean
  onHide: () => void
  size?: 'sm' | 'lg'
  centered?: boolean
  backdrop?: boolean | 'static'
  keyboard?: boolean
}

export function OLModal({
  children,
  className,
  show = false,
  onHide,
  size,
  centered,
  ...rest
}: OLModalProps): ReactNode {
  useEscapeKey(show, onHide)

  useEffect(() => {
    if (!show || typeof document === 'undefined') return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [show])

  if (!show || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className="modal-backdrop fade show" />
      <div
        className={classNames('modal', 'fade', 'show', { 'd-block': show })}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        {...rest}
      >
        <div
          className={classNames(
            'modal-dialog',
            size ? `modal-${size}` : undefined,
            { 'modal-dialog-centered': centered },
            className
          )}
        >
          <div className="modal-content">{children}</div>
        </div>
      </div>
    </>,
    document.body
  )
}

export function OLModalHeader({
  children,
  closeButton = true,
  onHide,
  ...rest
}: LooseProps & { closeButton?: boolean; onHide?: () => void }): ReactElement {
  return (
    <div className="modal-header" {...rest}>
      {children}
      {closeButton && (
        <button
          type="button"
          className="btn-close"
          aria-label="Close"
          onClick={onHide}
        />
      )}
    </div>
  )
}

export function OLModalTitle({
  children,
  ...rest
}: LooseProps): ReactElement {
  return (
    <h2 className="modal-title" {...rest}>
      {children}
    </h2>
  )
}

export function OLModalBody({ children, ...rest }: LooseProps): ReactElement {
  return (
    <div className="modal-body" {...rest}>
      {children}
    </div>
  )
}

export function OLModalFooter({ children, ...rest }: LooseProps): ReactElement {
  return (
    <div className="modal-footer" {...rest}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------- Popover */

export function OLPopover({
  title,
  children,
  className,
  style,
  ...rest
}: LooseProps & { title?: ReactNode }): ReactElement {
  return (
    <div
      className={classNames('popover', 'show', className)}
      role="tooltip"
      style={style}
      {...rest}
    >
      {title && <div className="popover-header">{title}</div>}
      <div className="popover-body">{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------- Overlay */

export type OLOverlayProps = {
  show?: boolean
  target?: HTMLElement | null
  placement?: string
  container?: Element | null
  children: ReactElement
  onHide?: () => void
  /** Accepted for parity with react-bootstrap; transitions are not animated. */
  transition?: boolean
  containerPadding?: number
  rootClose?: boolean
}

/**
 * Positions `children` next to `target` using the browser's own layout: the
 * overlay is portalled to `container` and offset with the target's bounding
 * box, which is enough for the editor's small toolbar menus.
 */
export function OLOverlay({
  show,
  target,
  placement = 'bottom-start',
  container,
  children,
}: OLOverlayProps): ReactNode {
  const [position, setPosition] = useState<CSSProperties>({})

  useEffect(() => {
    if (!show || !target) return
    const update = () => {
      const rect = target.getBoundingClientRect()
      const top = placement.startsWith('top')
        ? rect.top - 4
        : rect.bottom + 4
      const left = placement.endsWith('end') ? rect.right : rect.left
      setPosition({
        position: 'fixed',
        top,
        left,
        transform: placement.startsWith('top') ? 'translateY(-100%)' : undefined,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [show, target, placement])

  if (!show) return null

  const content = (
    <div className="overlay" style={position}>
      {children}
    </div>
  )

  if (typeof document === 'undefined') return content
  return createPortal(content, container ?? document.body)
}

/* ------------------------------------------------------------------ Dropdown */

export interface OLDropdownContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  registerToggle: () => () => void
  hasToggle: boolean
}

const OLDropdownContext = createContext<OLDropdownContextValue | null>(null)

export function OLDropdown({
  children,
  className,
  show,
  onToggle,
  ...rest
}: LooseProps): ReactElement {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = show ?? uncontrolledOpen
  const [toggleCount, setToggleCount] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const setOpen = useCallback(
    (next: boolean) => {
      if (show === undefined) setUncontrolledOpen(next)
      onToggle?.(next)
    },
    [show, onToggle]
  )

  useClickOutside(containerRef, open, () => setOpen(false))
  useEscapeKey(open, () => setOpen(false))

  const registerToggle = useCallback(() => {
    setToggleCount(count => count + 1)
    return () => setToggleCount(count => count - 1)
  }, [])

  const value: OLDropdownContextValue = {
    open,
    setOpen,
    registerToggle,
    hasToggle: toggleCount > 0,
  }

  return (
    <OLDropdownContext.Provider value={value}>
      <div
        ref={containerRef}
        className={classNames('dropdown', { show: open }, className)}
        {...rest}
      >
        {children}
      </div>
    </OLDropdownContext.Provider>
  )
}

export function OLDropdownToggle({
  children,
  className,
  ...rest
}: LooseProps): ReactElement {
  const context = useContext(OLDropdownContext)
  const registerToggle = context?.registerToggle

  useLayoutEffect(() => registerToggle?.(), [registerToggle])

  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={context?.open ?? false}
      className={classNames('dropdown-toggle', className)}
      onClick={() => context?.setOpen(!context.open)}
      {...rest}
    >
      {children}
    </button>
  )
}

export const OLDropdownMenu = forwardRef<HTMLUListElement, LooseProps>(
  function OLDropdownMenu({ children, className, ...rest }, ref): ReactElement {
    const context = useContext(OLDropdownContext)
    return (
      <ul
        ref={ref}
        role="menu"
        className={classNames(
          'dropdown-menu',
          { show: context?.open, 'dropdown-menu-popper': context?.hasToggle },
          className
        )}
        {...rest}
      >
        {children}
      </ul>
    )
  }
)

export interface OLDropdownItemProps extends LooseProps {
  description?: ReactNode
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

export const OLDropdownItem = forwardRef<HTMLButtonElement, OLDropdownItemProps>(
  function OLDropdownItem(
    {
      children,
      className,
      description,
      leadingIcon,
      trailingIcon,
      active,
      onClick,
      as: _as,
      ...rest
    },
    ref
  ): ReactElement {
    const context = useContext(OLDropdownContext)
    return (
      <li role="none">
        <button
          ref={ref}
          type="button"
          role="menuitem"
          className={classNames('dropdown-item', { active }, className)}
          onClick={event => {
            onClick?.(event)
            context?.setOpen(false)
          }}
          {...rest}
        >
          {leadingIcon && (
            <span className="dropdown-item-leading-icon">{leadingIcon}</span>
          )}
          {description ? (
            <span className="dropdown-item-description-container">
              {children}
              <span className="dropdown-item-description">{description}</span>
            </span>
          ) : (
            children
          )}
          {trailingIcon && (
            <span className="dropdown-item-trailing-icon">{trailingIcon}</span>
          )}
        </button>
      </li>
    )
  }
)

export function OLDropdownDivider(): ReactElement {
  return <li role="separator" className="dropdown-divider" />
}

export function OLDropdownHeader({ children }: LooseProps): ReactElement {
  return (
    <li role="presentation" className="dropdown-header">
      {children}
    </li>
  )
}

/* ------------------------------------------------------- Layout and form atoms */

export function OLRow({ children, className, ...rest }: LooseProps): ReactElement {
  return (
    <div className={classNames('row', className)} {...rest}>
      {children}
    </div>
  )
}

export function OLCol({ children, className, ...rest }: LooseProps): ReactElement {
  return (
    <div className={classNames('col', className)} {...rest}>
      {children}
    </div>
  )
}

export function OLForm({ children, className, ...rest }: LooseProps): ReactElement {
  return (
    <form
      className={className}
      onSubmit={event => event.preventDefault()}
      {...rest}
    >
      {children}
    </form>
  )
}

export function OLFormGroup({
  children,
  className,
  ...rest
}: LooseProps): ReactElement {
  return (
    <div className={classNames('form-group', className)} {...rest}>
      {children}
    </div>
  )
}

export function OLFormLabel({
  children,
  className,
  ...rest
}: LooseProps): ReactElement {
  return (
    <label className={classNames('form-label', className)} {...rest}>
      {children}
    </label>
  )
}

export type OLFormControlProps = LooseProps & {
  prepend?: ReactNode
  append?: ReactNode
  loading?: boolean
  value?: string | number | readonly string[]
  defaultValue?: string | number | readonly string[]
  placeholder?: string
  name?: string
  type?: string
  rows?: number
  autoFocus?: boolean
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
  'data-ol-dirty'?: unknown
  'main-field'?: unknown
}

export const OLFormControl = forwardRef<HTMLInputElement, OLFormControlProps>(
  ({ prepend, append, loading, className, rows, ...rest }, ref): ReactElement => {
    const resolvedAppend = loading ? (
      <span className="spinner-border spinner-border-sm" aria-hidden="true" />
    ) : (
      append
    )

    const control = rows ? (
      <textarea
        className={classNames('form-control', className)}
        rows={rows}
        {...(rest as Record<string, unknown>)}
      />
    ) : (
      <input
        ref={ref}
        className={classNames('form-control', className)}
        {...(rest as Record<string, unknown>)}
      />
    )

    if (!prepend && !resolvedAppend) return control

    return (
      <div
        className={classNames('form-control-wrapper', {
          'form-control-wrapper-disabled': rest.disabled,
        })}
      >
        {prepend && <span className="form-control-start-icon">{prepend}</span>}
        {control}
        {resolvedAppend && (
          <span className="form-control-end-icon">{resolvedAppend}</span>
        )}
      </div>
    )
  }
)
OLFormControl.displayName = 'OLFormControl'

export type OLFormCheckboxProps = LooseProps & {
  type?: 'checkbox' | 'radio' | 'switch'
  label?: ReactNode
  description?: string
  checked?: boolean
  defaultChecked?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
  inline?: boolean
}

export function OLFormCheckbox({
  type = 'checkbox',
  label,
  description,
  className,
  id,
  inputRef,
  inline,
  ...rest
}: OLFormCheckboxProps): ReactElement {
  const descriptionId = description && id ? `${id}-description` : undefined
  return (
    <div
      className={classNames(
        'form-check',
        { 'form-check-inline': inline },
        className
      )}
    >
      <input
        ref={inputRef}
        id={id}
        type={type === 'switch' ? 'checkbox' : type}
        className="form-check-input"
        aria-describedby={descriptionId}
        {...(rest as Record<string, unknown>)}
      />
      {(label || description) && (
        <label className="form-check-label" htmlFor={id}>
          {label}
          {description && (
            <span id={descriptionId} className="form-check-label-description">
              {description}
            </span>
          )}
        </label>
      )}
    </div>
  )
}

export function OLFormText({
  children,
  className,
  type = 'default',
  ...rest
}: LooseProps & { type?: string }): ReactElement {
  const typeClass =
    type === 'error'
      ? 'text-danger'
      : type === 'success'
        ? 'text-success'
        : type === 'warning'
          ? 'text-warning'
          : undefined
  return (
    <div className={classNames('form-text', typeClass, className)} {...rest}>
      {children}
    </div>
  )
}

export function OLListGroup({
  children,
  className,
  ...rest
}: LooseProps): ReactElement {
  return (
    <div className={classNames('list-group', className)} {...rest}>
      {children}
    </div>
  )
}

export function OLListGroupItem({
  children,
  className,
  disabled,
  disabledReason,
  ...rest
}: LooseProps & { disabledReason?: string }): ReactElement {
  const item = (
    <button
      type="button"
      className={classNames('list-group-item', 'list-group-item-action', className)}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      {...rest}
    >
      {children}
    </button>
  )
  return item
}

export function OLToggleButton({
  children,
  className,
  checked,
  value,
  onChange,
  ...rest
}: LooseProps & {
  checked?: boolean
  value?: string
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
}): ReactElement {
  return (
    <label className={classNames('btn', { active: checked }, className)}>
      <input
        type="checkbox"
        className="btn-check"
        checked={checked ?? false}
        value={value}
        onChange={onChange}
        {...(rest as Record<string, unknown>)}
      />
      {children}
    </label>
  )
}

export function OLToggleButtonGroup<T>({
  children,
  className,
  value,
  onChange,
  ...rest
}: LooseProps & {
  value?: T
  onChange?: (value: T) => void
}): ReactElement {
  return (
    <div
      className={classNames('btn-group', className)}
      role="group"
      data-value={String(value)}
      data-on-change={onChange ? 'true' : undefined}
      {...rest}
    >
      {children}
    </div>
  )
}

export function OLCloseButton({
  className,
  onClick,
  ...rest
}: LooseProps): ReactElement {
  return (
    <button
      type="button"
      aria-label="Close"
      className={classNames('btn-close', className)}
      onClick={onClick}
      {...rest}
    />
  )
}

export function OLSpinner({
  size = 'sm',
  className,
}: {
  size?: 'sm' | 'lg'
  className?: string
}): ReactElement {
  return (
    <span
      role="progressbar"
      aria-hidden="true"
      data-testid="ol-spinner"
      className={classNames('spinner-border', `spinner-border-${size}`, className)}
    />
  )
}
