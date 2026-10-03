import React from 'react';
import { useAppState } from '../state';
import { Menu } from './icons';

export interface TopLeftMenuButtonProps {
  /** Optional custom click handler; defaults to toggling Menu in the sidebar */
  onClick?(): void;
  style?: React.CSSProperties;
}

/**
 * TopLeftMenuButton — the compact Menu control docked at the leading edge of the
 * tab strip when the Panel Bar is collapsed.
 *
 * It is an ordinary quiet icon button: a 26×22 box, a muted glyph, a hover that
 * is a surface, and the accent tint when the menu view is showing. That is the
 * whole design, and it is deliberately the same design as every other icon
 * button in the strip — a control that appears in the tab bar's leading corner
 * has to look like it has always been part of it, or collapsing the Panel Bar
 * reads as something having gone wrong rather than as a layout the user chose.
 *
 * Its state is published as `aria-expanded` (it opens a view rather than
 * pressing a toggle), so the "on" treatment is written against that attribute in
 * `../overlays.css` and cannot disagree with what assistive technology is told.
 */
export const TopLeftMenuButton: React.FC<TopLeftMenuButtonProps> = ({ onClick, style }) => {
  const { sidebarVisible, sidebarView, setSidebarView, toggleSidebar } = useAppState();

  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (onClick) {
      onClick();
      return;
    }
    if (sidebarVisible && sidebarView === 'menu') {
      toggleSidebar();
    } else {
      setSidebarView('menu');
    }
  };

  const isMenuOpen = sidebarVisible && sidebarView === 'menu';

  return (
    <button
      type="button"
      data-testid="top-left-menu-button"
      aria-label="Menu"
      aria-expanded={isMenuOpen}
      // The shortcut named here is this button's own command, and there is none:
      // the Menu view is a view, reached by a click or by `view.menu`. Claiming
      // someone else's key would be worse than claiming none, and there is no
      // menu-bar key left to be tempted by — `Ctrl+Alt+M` and the command it
      // belonged to went with the window's menu strip.
      title="Menu"
      onClick={handleClick}
      // `.eu-icon-btn` and `.eu-pressable` are the design system's: the hover,
      // the press and the dip on press come from there. `.eu-menu-button` in
      // `../overlays.css` adds the box and the expanded state, both of which are
      // this control's own.
      className="eu-icon-btn eu-pressable eu-menu-button"
      // The caller's overrides stay last, so a host that positions this control
      // (the tab bar does) still wins. Nothing else is inline: the geometry, the
      // hover and the expand state are all the stylesheet's now.
      style={style}
    >
      <span>
        <Menu size={14} strokeWidth={2} />
      </span>
      <span className="eu-sr-only">Menu</span>
    </button>
  );
};

export default TopLeftMenuButton;
