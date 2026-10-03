/**
 * Eukolia — Viewport stability across container geometry changes.
 *
 * When the sidebar is toggled or resized, the split pane is dragged, or the
 * window is resized, the editor container width changes. Because word-wrap is
 * active in both Code and Visual modes, wrapped lines reflow and change height.
 *
 * Without viewport anchoring, the browser preserves the raw pixel `scrollTop`,
 * which causes lines above the viewport to shift content vertically — making the
 * text, mouse cursor position, and caret twitch, jerk, or jump away from what
 * the user is reading or editing.
 *
 * This extension maintains an active anchor:
 * 1. If the caret is inside the viewport, the caret's line and its exact vertical
 *    offset from the viewport top are held.
 * 2. If the caret is offscreen (user scrolled away), the topmost visible line
 *    and its offset from the viewport top are held.
 *
 * On width changes, the extension recalculates the new vertical position of the
 * anchor line and adjusts `scrollTop` so the line remains fixed in place.
 */

import { ViewPlugin, type ViewUpdate } from '@codemirror/view'

export const viewportStability = ViewPlugin.define(view => {
  let lastWidth = view.scrollDOM.clientWidth
  let anchorPos = view.state.selection.main.head
  let anchorOffsetFromTop = 0
  let isUpdatingScroll = false

  const updateAnchor = () => {
    const scroller = view.scrollDOM
    const height = scroller.clientHeight
    if (height <= 0) return

    const top = scroller.scrollTop
    const head = view.state.selection.main.head
    const caretBlock = view.lineBlockAt(head)
    const caretInViewport =
      caretBlock.top >= top - 2 && caretBlock.bottom <= top + height + 2

    if (caretInViewport) {
      anchorPos = head
      anchorOffsetFromTop = caretBlock.top - top
    } else {
      const topBlock = view.lineBlockAtHeight(top)
      anchorPos = topBlock.from
      anchorOffsetFromTop = topBlock.top - top
    }
  }

  updateAnchor()

  return {
    update(update: ViewUpdate) {
      const widthChanged = update.geometryChanged && !isUpdatingScroll
      if (!widthChanged && !update.docChanged && !update.selectionSet) return

      /*
       * The layout reads belong in a measure cycle, not here.
       *
       * `lineBlockAt`, `lineBlockAtHeight`, `scrollHeight` and `clientWidth` all force
       * layout, and CodeMirror refuses that from inside an update: it throws
       * `Reading the editor layout isn't allowed during an update`, which aborts this
       * plugin's `update` and everything it was going to do. This used to call
       * `updateAnchor()` — and therefore `lineBlockAtHeight` — on **every**
       * `docChanged` or `selectionSet` update, so the packaged editor produced that
       * exception on every keystroke and every caret move (visible in the console the
       * user reported).
       *
       * `requestMeasure` is the part of the frame where the same reads are legal, and
       * it coalesces to one read per frame however many updates arrived. The order of
       * the two cases is unchanged: a significant width change compensates the scroll
       * and does not re-anchor; anything else re-anchors.
       */
      update.view.requestMeasure({
        read: measured => {
          const scroller = measured.scrollDOM
          const newWidth = scroller.clientWidth

          if (widthChanged && newWidth > 0 && lastWidth > 0 && Math.abs(newWidth - lastWidth) >= 1) {
            lastWidth = newWidth
            const safePos = Math.min(Math.max(0, anchorPos), measured.state.doc.length)
            const block = measured.lineBlockAt(safePos)
            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
            return { scroll: Math.max(0, Math.min(block.top - anchorOffsetFromTop, maxScroll)) }
          }

          if (widthChanged) lastWidth = newWidth
          updateAnchor()
          return null
        },
        write: (measured, measuredView) => {
          if (!measured) return
          isUpdatingScroll = true
          try {
            measuredView.scrollDOM.scrollTop = measured.scroll
          } finally {
            isUpdatingScroll = false
          }
        }
      })
    },
    eventHandlers: {
      scroll() {
        if (!isUpdatingScroll) {
          updateAnchor()
        }
      },
    },
  }
})
