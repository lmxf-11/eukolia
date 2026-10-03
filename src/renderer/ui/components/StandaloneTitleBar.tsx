import React, { useEffect, useState } from 'react';
import { Maximize2, Minimize2, X, type LucideIcon } from './icons';

export const TITLE_BAR_HEIGHT = 34;

export interface StandaloneTitleBarProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  onClose?: () => void;
}

/**
 * The title bar of Eukolia's auxiliary windows — Settings and the Snippet
 * Library.
 *
 * Those windows are separate BrowserWindows, so they get none of the main
 * window's chrome for free. They used to draw their own bar from a handful of
 * inline styles, which is how an application ends up with two title bars that
 * are 34px tall and otherwise unrelated: a different surface, a different
 * wordmark, a different hover on the window controls.
 *
 * So this is the shell's `.eu-title-bar` — the same toolbar background, the same
 * sheen, the same hairline, the same `.eu-window-button` treatment down to the
 * red close, and the same three buttons the main window's tab bar draws — and
 * only the height is inline, because it is exported as `TITLE_BAR_HEIGHT` and the
 * two windows lay their content out against it. Opening Settings should feel like
 * a panel of the application appearing, not a second application.
 *
 * These windows carry their own controls on every platform, including Windows.
 * `hasNativeWindowControls` no longer decides it: `titleBarOverlay` is not
 * configured for them any more (see `main/windows.ts`), so a reservation for the
 * platform's buttons would be 140px of empty bar with this component's own three
 * buttons sitting *inside* it — which is exactly what it looked like.
 */
export const StandaloneTitleBar: React.FC<StandaloneTitleBarProps> = ({
  title,
  subtitle,
  icon: Icon,
  onClose
}) => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!window.eukoliaApi?.isWindowMaximized) return;
    void window.eukoliaApi.isWindowMaximized().then(setMaximized).catch(() => undefined);
    return window.eukoliaApi.onWindowMaximizedChanged?.(setMaximized);
  }, []);

  const handleMinimize = () => {
    void window.eukoliaApi?.minimizeWindow?.();
  };

  const handleToggleMaximize = () => {
    void window.eukoliaApi?.toggleMaximizeWindow?.().then(setMaximized).catch(() => undefined);
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else {
      void window.eukoliaApi?.closeWindow?.();
    }
  };

  return (
    <header
      // `.eu-title-bar` supplies the surface, the sheen, the hairline and the
      // drag layer's stacking context; `.eu-window-button` below opts the
      // controls out of the drag region.
      className="eu-title-bar"
      style={{
        height: TITLE_BAR_HEIGHT,
        width: '100%',
        zIndex: 50
      }}
    >
      {/* The whole bar is the window's drag handle; the controls below opt out
          with `.eu-window-button`'s own `no-drag`. */}
      <div className="eu-title-bar__drag" />

      <div className="eu-title-bar__brand eu-standalone-title__brand">
        {/* The wordmark tile: the same gradient `.eu-logo` the shell's tab bar
            draws, at the same 18px, so the windows carry one mark. */}
        <span className="eu-logo">Eu</span>
        {Icon && <Icon size={14} className="eu-standalone-title__icon" />}
        <span className="eu-standalone-title__text">{title}</span>
        {subtitle && <span className="eu-standalone-title__subtitle">— {subtitle}</span>}
      </div>

      <div className="eu-window-controls eu-standalone-title__controls">
        <button
          type="button"
          onClick={handleMinimize}
          className="eu-window-button eu-standalone-title__button"
          title="Minimize"
        >
          <Minimize2 size={12} />
        </button>
        <button
          type="button"
          onClick={handleToggleMaximize}
          className="eu-window-button eu-standalone-title__button"
          title={maximized ? 'Restore' : 'Maximize'}
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          onClick={handleClose}
          // Close is the one window control allowed to be red, and only under
          // the pointer — the same treatment the main window's tab bar gives it,
          // from the same class.
          className="eu-window-button eu-window-button--close eu-standalone-title__button"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
};

export default StandaloneTitleBar;
