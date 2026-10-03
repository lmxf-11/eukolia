/**
 * Eukolia substitution for Overleaf's Material Symbols icon components.
 *
 * Overleaf renders icons as a ligature-font `<span class="material-symbols">`.
 * Eukolia keeps exactly that markup (so the icon font stylesheet can style it)
 * and additionally exposes the original ligature name for tests and for
 * consumers that prefer an inline SVG.
 */
import { memo, type ComponentProps, type ReactElement } from 'react'
import classNames from './classnames'

export type IconProps = ComponentProps<'span'> & {
  type: string
  accessibilityLabel?: string
  modifier?: string
  size?: '2x'
  unfilled?: boolean
}

function MaterialIcon({
  type,
  className,
  accessibilityLabel,
  modifier,
  size,
  unfilled,
  ...rest
}: IconProps): ReactElement {
  const iconClassName = classNames('material-symbols', className, modifier, {
    [`size-${size}`]: size,
    unfilled,
  })

  return (
    <>
      <span
        className={iconClassName}
        aria-hidden="true"
        translate="no"
        data-icon={type}
        {...rest}
      >
        {type}
      </span>
      {accessibilityLabel && (
        <span className="visually-hidden">{accessibilityLabel}</span>
      )}
    </>
  )
}

export default memo(MaterialIcon)

/** Imperative variant used by the visual widgets, which build plain DOM. */
export function materialIcon(type: string): HTMLSpanElement {
  const icon = document.createElement('span')
  icon.className = 'material-symbols'
  icon.textContent = type
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('translate', 'no')
  icon.dataset.icon = type
  return icon
}
