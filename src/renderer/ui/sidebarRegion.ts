/**
 * Eukolia — the sidebar region's visibility rule.
 *
 * Explorer, Search, Outline, Symbols, Snippets and Problems are not six panels
 * that happen to sit in a column; they are the *views* of one panel. `Sidebar.tsx`
 * switches over `sidebarView` and renders exactly one of them, and `App.tsx`
 * wraps the lot in a single element beside a single resize handle. So the
 * sidebar is one region, and it is shown or hidden as one thing.
 *
 * That region can be taken off screen by any of three conditions, and they are
 * easy to disagree about because only the first is a flag the shell stores:
 *
 *   1. the user collapsed it — `sidebarVisible`;
 *   2. no view has ever been chosen — `sidebarView` is `null`;
 *   3. the settings pane is up, and it occupies the sidebar's slot.
 *
 * Disagreement here is not cosmetic. The rule used to be spelled out separately
 * at each site, and two spellings drifted: `App.tsx` refused to render the
 * sidebar while settings were open, but the status bar's toggle still reported
 * `aria-pressed={sidebarVisible}`. With Settings up, that control claimed the
 * sidebar was showing while the screen showed no sidebar at all — and pressing
 * it wrote the flag rather than fixing the screen, so the control reported a
 * panel it could not reveal.
 *
 * Hence one function, in a module that depends on nothing: the shell renders
 * from it, the status bar reports it, the activity bar marks its active view
 * with it, and `toggleSidebar` acts on it. It lives here rather than in
 * `state.tsx` so that components and tests can reach the rule without pulling in
 * the provider and every service it starts.
 */

/** The three fields that between them decide whether the sidebar is on screen. */
export interface SidebarRegionInput {
  /** The user's standing request to see the sidebar. */
  visible: boolean;
  /** The view it would show; `null` means no view has been chosen. */
  view: string | null;
  /** Whether the settings pane is up, since it replaces the sidebar's slot. */
  settingsOpen: boolean;
}

/**
 * Whether the sidebar region — and with it every view panel it holds — is on
 * screen. False means none of them is rendered, which is the whole point of
 * answering it once.
 */
export function sidebarShown({ visible, view, settingsOpen }: SidebarRegionInput): boolean {
  return visible && view !== null && !settingsOpen;
}

/** What decides whether the activity bar renders. */
export interface SidebarChromeInput {
  /** The user's standing request to see the sidebar — `SidebarRegionInput.visible`. */
  sidebarRequested: boolean;
  /** `appearance.showActivityBar`: the setting that turns the strip off entirely. */
  activityBarEnabled: boolean;
  /**
   * `appearance.collapseActivityBarWithSidebar`: whether collapsing the sidebar
   * takes panel buttons with it, or leaves them as the way back.
   */
  collapseWithSidebar: boolean;
}

/**
 * Whether the activity bar view switchers / panel chrome are on screen.
 *
 * By default it comes and goes with the region it switches: leaving it behind
 * after a collapse puts the buttons for six panels on screen with none of those
 * panels rendered.
 *
 * `collapseWithSidebar` is the escape hatch: tied together (`true`, the default),
 * the panel buttons collapse with the sidebar. Left independent (`false`), the
 * panel buttons stay visible even when the sidebar collapses.
 */
export function sidebarChromeVisible({
  sidebarRequested,
  activityBarEnabled,
  collapseWithSidebar
}: SidebarChromeInput): boolean {
  if (!activityBarEnabled) return false;
  // Independent: the strip is up whenever the setting allows, collapse or not.
  if (!collapseWithSidebar) return true;
  return sidebarRequested;
}

export interface PanelButtonsVisibleInput {
  /** The user's standing request to see the sidebar — `SidebarRegionInput.visible`. */
  sidebarRequested: boolean;
  /**
   * `appearance.collapseActivityBarWithSidebar`: whether collapsing the sidebar
   * takes the panel buttons with it, or leaves them as the way back.
   */
  collapseWithSidebar: boolean;
}

/**
 * Whether the panel buttons (Explorer, Search, Outline, Symbols, Snippets, Problems)
 * are rendered in the activity bar.
 *
 * Toggling panel buttons does not hide the Menu button. If `collapseWithSidebar` is true
 * (Toggle Panel Bar is off), collapsing the sidebar also hides these panel buttons.
 * If `collapseWithSidebar` is false (Toggle Panel Bar is on), the panel buttons remain visible
 * even when the sidebar is collapsed.
 */
export function panelButtonsVisible({
  sidebarRequested,
  collapseWithSidebar
}: PanelButtonsVisibleInput): boolean {
  if (!collapseWithSidebar) return true;
  return sidebarRequested;
}

