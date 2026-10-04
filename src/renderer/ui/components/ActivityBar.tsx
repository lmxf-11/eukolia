/**
 * ActivityBar — the vertical strip of view icons down the left edge.
 *
 * This is VS Code's activity bar: one icon per sidebar view, the active one
 * marked, and clicking the active icon hides the sidebar (so the same control
 * both switches and dismisses, which is what makes a narrow strip enough for
 * both jobs).
 *
 * Eukolia already had every sidebar view and a way to switch between them — from
 * the palette, from the sidebar's own header and from `view.*` commands — but no
 * persistent, discoverable control for it. That is all this adds: it reads
 * `sidebarView` / `sidebarVisible` and calls the existing `setSidebarView`, so it
 * owns no state and cannot disagree with the commands.
 *
 * The bottom of the strip carries the two things VS Code puts there: the settings
 * gear and the keyboard-shortcuts entry. Both are ordinary commands, so they are
 * dispatched through the registry rather than implemented here.
 */

import React from 'react';
import { useAppState, type SidebarView } from '../state';
import { panelButtonsVisible, sidebarShown } from '../sidebarRegion';
import { commandRegistry } from '../../core/commands';
import { setting, settingsManager } from '../../core/settings';
import {
  Boxes,
  Folder,
  Keyboard,
  Library,
  ListTree,
  Menu,
  Search,
  Settings,
  Sigma,
  TriangleAlert,
  Zap,
  type LucideIcon
} from './icons';

/** One entry in the strip. */
export interface ActivityBarItem {
  /** The sidebar view this icon shows, or `null` for a command-only entry. */
  view: SidebarView | null;
  label: string;
  icon: LucideIcon;
  /** Command to run instead of switching views; used by the entry at the foot. */
  command?: string;
}

/** The Menu view item at the top of the strip. Never hidden by toggling panel buttons. */
export const MENU_BAR_ITEM: ActivityBarItem = {
  view: 'menu',
  label: 'Menu',
  icon: Menu
};

/**
 * Panel buttons: the view switcher buttons for the sidebar panels.
 *
 * Ordered by how often a LaTeX author reaches for them: the file tree, then
 * search, then the document's own structure, then the two reference lists, then
 * diagnostics.
 *
 * The two symbol entries are deliberately adjacent and deliberately distinct.
 * **Project Symbols** navigates what this project already defines — labels,
 * citations, macros, environments. **Mathematical Symbols** is the catalog you
 * insert notation from. Putting them side by side is what makes the difference
 * legible; giving them different icons and labels is what keeps it honest.
 */
export const PANEL_BUTTON_ITEMS: readonly ActivityBarItem[] = [
  { view: 'explorer', label: 'Explorer', icon: Folder },
  { view: 'search', label: 'Search', icon: Search },
  { view: 'outline', label: 'Outline', icon: ListTree },
  { view: 'symbols', label: 'Project Symbols', icon: Boxes },
  { view: 'math-symbols', label: 'Mathematical Symbols', icon: Sigma },
  { view: 'snippets', label: 'Snippets', icon: Zap },
  { view: 'problems', label: 'Problems', icon: TriangleAlert }
];

/**
 * The strip's view entries, top to bottom.
 */
export const ACTIVITY_BAR_ITEMS: readonly ActivityBarItem[] = [
  MENU_BAR_ITEM,
  ...PANEL_BUTTON_ITEMS
];

/** The entries pinned to the foot of the strip, as VS Code does with its gear. */
export const ACTIVITY_BAR_FOOTER: readonly ActivityBarItem[] = [
  { view: null, label: 'Keyboard Shortcuts', icon: Keyboard, command: 'workbench.shortcuts' }
];

/**
 * The view a click should select.
 *
 * Clicking the active view hides the sidebar rather than re-selecting it, and
 * clicking a different view while the sidebar is hidden reveals it on that view.
 * Extracted because it is the whole behaviour of the strip and is worth testing
 * without a DOM.
 */
export function nextSidebarView(
  current: SidebarView | null,
  visible: boolean,
  clicked: SidebarView
): SidebarView | null {
  if (visible && current === clicked) return null;
  return clicked;
}

export interface ActivityBarProps {
  collapseWithSidebar?: boolean;
}

export const ActivityBar: React.FC<ActivityBarProps> = ({ collapseWithSidebar: collapseProp }) => {

  const { sidebarView, sidebarVisible, settingsOpen, setSidebarView, toggleSettings } = useAppState();

  const [settingsRevision, setSettingsRevision] = React.useState(0);
  React.useEffect(() => settingsManager.on('change', () => setSettingsRevision((value) => value + 1)), []);
  const collapseWithSidebar = React.useMemo(
    () => (collapseProp !== undefined ? collapseProp : setting.bool('appearance.collapseActivityBarWithSidebar')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collapseProp, settingsRevision]
  );

  // The strip has one active slot at a time. While the settings pane is up it
  // owns that slot — the pane replaces the sidebar and the editor — so the view
  // icons stop reading as selected even though `sidebarView` still remembers
  // which view the gear will reveal. `sidebarShown` is the shell's own answer to
  // "is the sidebar on screen?", so the icons cannot mark a view as showing when
  // the region holding it is not rendered.
  const sidebarIsShown = sidebarShown({ visible: sidebarVisible, view: sidebarView, settingsOpen });
  const activeView = sidebarIsShown ? (sidebarView as SidebarView | null) : null;

  const select = (view: SidebarView) => {
    // The same control switches and dismisses: clicking the active icon hides
    // the sidebar. `setSidebarView` is also what brings the settings pane down,
    // so reaching any view from inside Settings is one click.
    //
    // This passes `sidebarVisible` and not `sidebarIsShown`, and the difference
    // is deliberate: "is the active icon showing" and "should this click
    // dismiss" are different questions. Behind the settings pane the active
    // marker is cleared, so a click reads as a switch — which is what it is,
    // because `setSidebarView` takes the pane down and lands on the view.
    setSidebarView(nextSidebarView(activeView, sidebarVisible, view));
  };

  const showPanelButtons = panelButtonsVisible({
    sidebarRequested: sidebarVisible,
    collapseWithSidebar
  });

  return (
    <div
      className="eu-activity-bar"
      style={bar}
      data-testid="activity-bar"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Views"
    >
      {/* Menu button: permanently shown at top of strip */}
      <ActivityButton
        key={MENU_BAR_ITEM.view ?? MENU_BAR_ITEM.label}
        item={MENU_BAR_ITEM}
        active={activeView === MENU_BAR_ITEM.view}
        onSelect={() => MENU_BAR_ITEM.view && select(MENU_BAR_ITEM.view)}
        customStyle={{ animation: 'menuTransitionToActivityBar 0.28s cubic-bezier(0.16, 1, 0.3, 1)' }}
      />

      {/* Panel buttons: shown when sidebar is open or when Toggle Panel Bar is on */}
      {showPanelButtons &&
        PANEL_BUTTON_ITEMS.map((item, index) => (
          <ActivityButton
            key={item.view ?? item.label}
            item={item}
            active={activeView === item.view}
            onSelect={() => item.view && select(item.view)}
            customStyle={{
              animation: `panelButtonsCascadeIn 0.24s cubic-bezier(0.16, 1, 0.3, 1) ${30 + index * 25}ms both`
            }}
          />
        ))}

      <span className="eu-activity-bar__spacer" />


      {ACTIVITY_BAR_FOOTER.map((item) => (
        <ActivityButton
          key={item.label}
          item={item}
          active={false}
          onSelect={() => {
            if (item.command) void commandRegistry.execute(item.command);
          }}
        />
      ))}

      <ActivityButton
        item={{ view: null, label: 'Settings', icon: Settings }}
        // The gear is marked while the settings pane is open and closes it when
        // pressed again, so it does for settings what the view icons above it do
        // for their views.
        active={settingsOpen}
        onSelect={() => {
          if (window.eukoliaApi?.openSettingsWindow) {
            void window.eukoliaApi.openSettingsWindow();
          } else {
            toggleSettings();
          }
        }}
      />
    </div>
  );
};

const ActivityButton: React.FC<{
  item: ActivityBarItem;
  active: boolean;
  onSelect(): void;
  customStyle?: React.CSSProperties;
}> = ({ item, active, onSelect, customStyle }) => {
  const Icon = item.icon;

  return (
    <button
      type="button"
      title={item.label}
      aria-label={item.label}
      aria-pressed={item.view ? active : undefined}
      data-testid={`activity-bar-${item.view ?? item.label.toLowerCase().replace(/\s+/g, '-')}`}
      data-active={active ? 'true' : 'false'}
      data-eu-active={active ? 'true' : 'false'}
      className="eu-activity-item eu-pressable"
      onClick={onSelect}
      style={customStyle}
    >
      {/* The active marker is the accent rule on the leading edge, which is how
          VS Code shows the selected view. It is always in the tree and fades in
          through its own class, so selecting a view animates rather than
          re-mounting the glyph. */}
      <span className="eu-activity-item__marker" aria-hidden="true" />
      <Icon size={20} strokeWidth={1.6} />
    </button>
  );
};

const BAR_WIDTH = 46;

const bar: React.CSSProperties = {
  width: BAR_WIDTH,
  animation: 'activityBarSlideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
};

export default ActivityBar;
