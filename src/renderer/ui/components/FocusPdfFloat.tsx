/**
 * Eukolia — Focus Mode's floating PDF viewer.
 *
 * Focus Mode is the editor alone, so the PDF pane cannot be docked beside it
 * without giving up the layout's whole point. Holding Alt floats the viewer over
 * the window's right-hand side instead, at a width of its own, and letting go
 * puts it away (`focusFloat.ts` owns that state machine and the reasons behind
 * it).
 *
 * The overlay is a plain absolutely-positioned box inside the application shell,
 * which is what keeps it free of the layout: opening it moves nothing, so the
 * editor keeps the width, the scroll position and the line the reader was on —
 * §37's "asynchronous rendering must not move the viewport", one level up.
 *
 * Its surface — the elevation, the hairline, the rounded outer corners and the
 * grab strip down its left edge — is `../overlays.css`'s, in the section it
 * shares with the application's other floating surfaces. What is left here is
 * the *placement*: the overlay sits inside the shell rather than over it, so the
 * distances from the window's top and bottom are facts only the caller knows,
 * and the drag that resizes it is the one interaction this component owns.
 */

import React, { useCallback, useRef, useState } from 'react';

import { focusFloatWidthAfterDrag } from '../focusFloat';

export interface FocusPdfFloatProps {
  /** The distance from the window's top to the shell's content, in pixels. */
  top: number;
  /** The distance from the shell's content to the window's bottom. */
  bottom: number;
  /** The viewer's own width, from `pdf.focusFloatWidth`. */
  width: number;
  open: boolean;
  /** Called when a drag on the left edge settles on a new width. */
  onResize(width: number): void;
  /** The pointer entered or left the overlay — see `focusFloat.ts`, decision 2. */
  onPointerInside(inside: boolean): void;
  children: React.ReactNode;
}

/** The grab strip down the overlay's left edge, centred on the seam. */
export const FOCUS_FLOAT_HANDLE_PIXELS = 6;

export const FocusPdfFloat: React.FC<FocusPdfFloatProps> = ({
  top,
  bottom,
  width,
  open,
  onResize,
  onPointerInside,
  children
}) => {
  const [dragging, setDragging] = useState(false);
  /** The width the drag is drawing, so the overlay follows the pointer live. */
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      let latest = startWidth;
      setDragging(true);
      setDraftWidth(startWidth);

      const onMove = (moveEvent: PointerEvent) => {
        // The overlay is anchored to the right edge, so a pointer moving left
        // makes it wider — the opposite sign to the sidebar's own drag.
        latest = focusFloatWidthAfterDrag(startWidth, startX, moveEvent.clientX);
        setDraftWidth(latest);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        setDragging(false);
        setDraftWidth(null);
        onResizeRef.current(latest);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [width]
  );

  return (
    <div
      data-testid="pdf-focus-float"
      data-open={open ? '1' : '0'}
      data-width={Math.round(draftWidth ?? width)}
      // `.eu-focus-float` supplies the surface — the large shadow, the hairline,
      // the rounded right-hand corners and the arrival transition. What is left
      // inline is everything only this render knows: where the overlay is pinned
      // (`top`/`bottom`/`right`, which come from the chrome's own height), how
      // wide it is (the drag's live draft, or the setting), whether it is open,
      // and the z-index that has to beat the editor without beating the tab bar.
      //
      // Hidden with `visibility` rather than unmounted, so the viewer inside it
      // is the same viewer every time the overlay appears: the document stays
      // open, the page and the scroll position stay where the reader left them,
      // and revealing it costs a paint rather than a re-open. `visibility` still
      // measures, which is what lets the viewer lay itself out while it is away.
      className="eu-focus-float"
      data-eu-dragging={dragging ? 'true' : undefined}
      style={{
        position: 'absolute',
        top,
        bottom,
        right: 0,
        width: draftWidth !== null ? draftWidth : width,
        zIndex: 5,
        visibility: open ? 'visible' : 'hidden',
        // A closed overlay must not take the pointer: it covers half the editor.
        pointerEvents: open ? 'auto' : 'none',
        // It is out of the way rather than gone, which is also what makes the
        // reveal read as the viewer arriving from the right edge.
        transform: open ? 'translateX(0)' : 'translateX(12px)',
        opacity: open ? 1 : 0
      }}
      onMouseEnter={() => onPointerInside(true)}
      onMouseLeave={() => onPointerInside(false)}
    >
      <div
        data-testid="pdf-focus-float-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the floating PDF viewer"
        title="Drag to resize the floating PDF viewer"
        onPointerDown={onHandlePointerDown}
        // The handle's *hit area* stays inline: it is derived from
        // `FOCUS_FLOAT_HANDLE_PIXELS`, exported above, and the component is the
        // only place that knows the strip is centred on the seam. The highlight
        // — a quiet seam that becomes an accent line under the pointer — is
        // `.eu-focus-float__handle` in `../overlays.css`.
        className="eu-focus-float__handle"
        style={{
          width: FOCUS_FLOAT_HANDLE_PIXELS,
          // Centred on the seam: half of the strip is the overlay's own edge,
          // half hangs over the editor, which is where a pointer reaching for
          // the seam actually is.
          marginLeft: -FOCUS_FLOAT_HANDLE_PIXELS / 2,
          cursor: 'col-resize',
          flexShrink: 0,
          touchAction: 'none'
        }}
      />
      <div className="eu-focus-float__viewer">{children}</div>
    </div>
  );
};

export default FocusPdfFloat;
