/**
 * Modal — the one dialog primitive used by the shell (About, shortcuts, the
 * build-recipe picker and anything else that needs the user's full attention).
 *
 * Accessibility is not optional here (Instructions.md §48): the dialog traps Tab
 * focus, closes on Escape and on a backdrop click, carries `role="dialog"` with
 * `aria-modal`, and hands focus back to whatever was focused before it opened.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { X } from './icons';
// The floating surfaces' own sheet: the dialog, the palette, quick open, the tab
// switcher and the floating PDF viewer are one problem — a surface with no
// neighbours — and state their geometry together. Imported from the dialog
// primitive because every one of the other four is either built on it or shares
// its backdrop. See the file's own header.
import '../overlays.css';

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** Preferred width in pixels, or any CSS length; the dialog still shrinks on narrow windows. */
  width?: number | string;
  /**
   * Height of the dialog. Omitted means "as tall as the content, up to the
   * window": a dialog that fills the screen is for a task that owns the screen —
   * the snippet library — and one that sizes itself is for a question.
   */
  height?: number | string;
  /**
   * Whether the content fills the dialog and owns its own layout.
   *
   * Without it the body carries the padding and the scrolling, which is what a
   * paragraph of text wants. With it the content is given the whole dialog and
   * lays itself out — panes, toolbars, its own scroll areas — as the snippet
   * library does.
   */
  fill?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable descendants of `container`, in DOM order. */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  );
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  width = 520,
  height,
  fill = false,
  children,
  footer
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // --------------------------------------------------------- focus lifecycle

  useEffect(() => {
    if (!open) return;

    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;

    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = focusableElements(dialog);
      (focusable[0] ?? dialog).focus();
    }

    return () => {
      const previous = restoreRef.current;
      restoreRef.current = null;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [open]);

  // --------------------------------------------------------------- keyboard

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (!open) return null;

  return (
    <div
      // The scrim is the design system's (`.eu-backdrop`: the fade, the tint and
      // the 2px blur); `--modal` is the one pixel more of blur and the margin a
      // height-capped dialog needs to be measured against.
      className="eu-backdrop eu-overlay--modal"
      // The z-index is the only thing the backdrop decides for itself: a dialog
      // has to sit above the palette's 220, and both are siblings of the shell.
      style={{ zIndex: 200 }}
      // `mousedown` rather than `click`, so a drag that starts inside the dialog
      // and ends on the backdrop does not dismiss it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="eu-dialog eu-modal"
        // `width` is the caller's request and `height` is optional per dialog, so
        // both are computed per render and stay here. The `maxWidth`/`maxHeight`
        // pair that keeps a dialog inside a small window is the stylesheet's.
        style={{ width, ...(height === undefined ? {} : { height }) }}
      >
        <div className="eu-dialog-header eu-dialog__header">
          <div className="eu-dialog-title">{title}</div>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close dialog"
            className="eu-icon-btn eu-dialog__close eu-focus-inset"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className={fill ? 'eu-dialog__body--fill' : 'eu-dialog__body'}>{children}</div>

        {footer && <div className="eu-dialog-footer eu-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
};

/**
 * The dialog's own geometry — surface, radius, elevation, and the caps that keep
 * it inside a small window — is `.eu-modal` in `../overlays.css`. It is a class
 * rather than a constant object because a dialog shares its surface with the
 * palette and the tab switcher, and three inline copies of "a floating panel" is
 * exactly how the three drifted apart. `width` and the optional `height` stay
 * inline above: they are the caller's request, computed per render.
 */

export default Modal;
