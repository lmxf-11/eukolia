export function widgetCoordsAt(
  element: HTMLElement,
  pos?: number,
  side?: number
) {
  const rect = element.getBoundingClientRect()
  if (
    !rect ||
    (rect.left === 0 &&
      rect.right === 0 &&
      rect.top === 0 &&
      rect.bottom === 0)
  ) {
    return null
  }
  const fromBack =
    (pos != null && pos > 0) || (side != null && side < 0)
  const x = fromBack ? rect.right : rect.left
  return {
    left: x,
    right: x,
    top: rect.top,
    bottom: rect.bottom,
  }
}
