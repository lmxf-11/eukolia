/**
 * Eukolia substitution for the shared UI atoms the ported editor components
 * import from Overleaf's `@/shared/components/*`.
 *
 * Each is a real component with the same props surface the ported call sites
 * use. They render semantic markup with the same Bootstrap class names Overleaf
 * applies, so Eukolia's stylesheet can theme them.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import classNames from './classnames'
import { useTranslation } from './i18n'
import MaterialIcon from './material-icon'
import OLButton from './ol/ol-button'
import OLTooltip from './ol/ol-tooltip'

/* --------------------------------------------------------------- Notification */

export interface NotificationProps {
  type?: 'info' | 'success' | 'warning' | 'error'
  /** Message body. Overleaf's `Notification` takes it as a prop, not children. */
  content?: ReactNode
  children?: ReactNode
  onDismiss?: () => void
  className?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

const Notification = forwardRef<HTMLDivElement, NotificationProps>(
  ({ type = 'info', content, children, onDismiss, className, ...rest }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={classNames(
        'notification',
        `notification-type-${type}`,
        className
      )}
      {...rest}
    >
      {content ?? children}
      {onDismiss && (
        <button
          type="button"
          className="notification-close"
          aria-label="Dismiss"
          onClick={onDismiss}
        />
      )}
    </div>
  )
)
Notification.displayName = 'Notification'

export default Notification

/* ---------------------------------------------------------- Loading spinners */

export function FullSizeLoadingSpinner({
  delay = 0,
  className,
}: {
  delay?: number
  className?: string
}): ReactNode {
  const [visible, setVisible] = useState(delay === 0)

  useEffect(() => {
    if (delay === 0) return
    const timer = window.setTimeout(() => setVisible(true), delay)
    return () => window.clearTimeout(timer)
  }, [delay])

  if (!visible) return null

  return (
    <div className={classNames('full-size-loading-spinner', className)}>
      <OLSpinner size="lg" />
    </div>
  )
}

export function OLSpinner({
  size = 'sm',
  className,
}: {
  size?: 'sm' | 'lg'
  className?: string
}): ReactNode {
  return (
    <span
      role="progressbar"
      aria-hidden="true"
      data-testid="ol-spinner"
      className={classNames('spinner-border', `spinner-border-${size}`, className)}
    />
  )
}

/* ----------------------------------------------------------------- CopyToClipboard */

export interface CopyToClipboardProps {
  content: string
  tooltipId: string
  kind?: 'text' | 'icon' | 'button'
  unfilled?: boolean
  onClick?: () => void
}

/**
 * Copies `content` to the clipboard, showing a tooltip that confirms the copy.
 * Same API as Overleaf's component; `navigator.clipboard` is available in
 * Chromium/Electron.
 */
export const CopyToClipboard = ({
  content,
  tooltipId,
  kind = 'icon',
  unfilled = false,
  onClick,
}: CopyToClipboardProps): ReactNode => {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleClick = useCallback(() => {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
    onClick?.()
  }, [content, onClick])

  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return null
  }

  return (
    <OLTooltip
      id={tooltipId}
      description={copied ? `${t('copied')}!` : t('copy')}
      overlayProps={{ delay: copied ? 1000 : 250 }}
    >
      {kind === 'text' ? (
        <OLButton
          onClick={handleClick}
          size="sm"
          variant="secondary"
          className="copy-button"
        >
          {t('copy')}
        </OLButton>
      ) : kind === 'button' ? (
        <OLButton
          onClick={handleClick}
          size="sm"
          variant="ghost"
          className="copy-button copy-button-ghost"
        >
          <MaterialIcon type={copied ? 'check' : 'content_copy'} unfilled={unfilled} />
          {t('copy')}
        </OLButton>
      ) : (
        <OLButton
          onClick={handleClick}
          size="sm"
          variant="link"
          className="copy-button"
        >
          <MaterialIcon
            type={copied ? 'check' : 'content_copy'}
            unfilled={unfilled}
            accessibilityLabel={t('copy')}
          />
        </OLButton>
      )}
    </OLTooltip>
  )
}

/* --------------------------------------------------------------------- Select */

export interface SelectProps<T> {
  /** The items rendered as options. */
  items: T[]
  /** Stringifies an item; the result is rendered as the option label. */
  itemToString?: (item: T | null | undefined) => string
  /** Caption for the control. */
  label?: ReactNode
  name?: string
  defaultText?: string
  defaultItem?: T | null
  itemToSubtitle?: (item: T | null | undefined) => string
  itemToKey: (item: T) => string
  itemToLeadingIcon?: (item: T | null | undefined) => ReactNode
  onSelectedItemChanged?: (item: T | null | undefined) => void
  selected?: T | null
  disabled?: boolean
  itemToDisabled?: (item: T | null | undefined) => boolean
  optionalLabel?: boolean
  loading?: boolean
  selectedIcon?: boolean
  dataTestId?: string
  size?: string
  id?: string
  className?: string
}

/**
 * A listbox with the same props surface as Overleaf's downshift-based `Select`.
 *
 * Eukolia implements it over a native `<select>` element: the editor's use of
 * `Select` is a small, finite choice (a column width unit), so a native control
 * gives correct keyboard interaction, screen-reader semantics and form
 * association without a third-party listbox dependency.
 */
export function Select<T>({
  items,
  itemToString = item => (item === null || item === undefined ? '' : String(item)),
  label,
  name,
  defaultText = 'Items',
  defaultItem,
  itemToSubtitle,
  itemToKey,
  onSelectedItemChanged,
  selected,
  disabled = false,
  itemToDisabled,
  optionalLabel = false,
  loading = false,
  dataTestId,
  size,
  id,
  className,
}: SelectProps<T>): ReactNode {
  const { t } = useTranslation()
  const generatedId = useId()
  const selectId = id ?? `select-${generatedId}`
  const [uncontrolled, setUncontrolled] = useState<T | null>(defaultItem ?? null)
  const value = selected !== undefined ? selected : uncontrolled

  const index = useMemo(
    () => items.findIndex(item => itemToKey(item) === (value ? itemToKey(value) : undefined)),
    [items, itemToKey, value]
  )

  return (
    <div className={classNames('select-wrapper', className)}>
      {label && (
        <label className="form-label" htmlFor={selectId}>
          {label}{' '}
          {optionalLabel && <span className="fw-normal">({t('optional')})</span>}{' '}
          {loading && <OLSpinner size="sm" />}
        </label>
      )}
      <select
        id={selectId}
        name={name}
        data-testid={dataTestId}
        className={classNames('form-select', 'select-trigger', {
          'form-select-sm': size === 'sm',
          'form-select-lg': size === 'lg',
        })}
        disabled={disabled}
        value={index >= 0 ? String(index) : ''}
        onChange={event => {
          const item = items[Number(event.target.value)] ?? null
          if (selected === undefined) setUncontrolled(item)
          onSelectedItemChanged?.(item)
        }}
      >
        {index < 0 && <option value="">{defaultText}</option>}
        {items.map((item, itemIndex) => (
          <option
            key={itemToKey(item)}
            value={String(itemIndex)}
            disabled={itemToDisabled?.(item) ?? false}
            title={itemToSubtitle?.(item)}
          >
            {itemToString(item)}
          </option>
        ))}
      </select>
    </div>
  )
}
