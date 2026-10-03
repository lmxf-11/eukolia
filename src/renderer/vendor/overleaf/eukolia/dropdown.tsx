/**
 * Eukolia substitution for Overleaf's dropdown menu items
 * (`@/vendor/overleaf/eukolia/dropdown`,
 * `@/vendor/overleaf/eukolia/dropdown`).
 *
 * The ported context menus only need a clickable item that closes the menu and
 * can render a leading icon; that is what these implement.
 */
import type { ReactNode } from 'react'
import classNames from './classnames'

export interface DropdownItemProps {
  children?: ReactNode
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  disabled?: boolean
  className?: string
  description?: ReactNode
  active?: boolean
  role?: string
  [key: string]: unknown
}

function DropdownItemBase({
  children,
  onClick,
  leadingIcon,
  trailingIcon,
  disabled,
  className,
  description,
  active,
  ...rest
}: DropdownItemProps): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-checked={active}
      className={classNames(
        'dropdown-item',
        { active, disabled },
        className
      )}
      onClick={onClick}
      {...rest}
    >
      {leadingIcon && (
        <span className="dropdown-item-leading-icon">{leadingIcon}</span>
      )}
      <span className="dropdown-item-content">
        {children}
        {description && (
          <span className="dropdown-item-description">{description}</span>
        )}
      </span>
      {trailingIcon && (
        <span className="dropdown-item-trailing-icon">{trailingIcon}</span>
      )}
    </button>
  )
}

export default DropdownItemBase
export { DropdownItemBase as DropdownListItem }
export { DropdownItemBase as DropdownMenuItem }
