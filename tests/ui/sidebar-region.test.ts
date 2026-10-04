/**
 * The sidebar region — Explorer, Search, Outline, Symbols, Snippets and Problems
 * are views of one panel, so whether they are on screen is one question with one
 * answer.
 *
 * This rule is worth a test of its own because the bug it replaces was not a
 * missing feature but a *disagreement*: `App.tsx` would not render the sidebar
 * while the settings pane was open, while the status bar's toggle reported
 * `aria-pressed={sidebarVisible}`. With Settings up the control claimed a
 * sidebar that was not on screen. Anything that answers "is the sidebar
 * showing?" has to answer it the way the shell renders it, which is what
 * `sidebarShown` is for.
 */

import { describe, expect, it } from 'vitest';
import { sidebarChromeVisible, sidebarShown } from '../../src/renderer/ui/sidebarRegion';

describe('when the sidebar region is on screen', () => {
  it('shows it when a view is chosen and nothing is over it', () => {
    expect(sidebarShown({ visible: true, view: 'explorer', settingsOpen: false })).toBe(true);
  });

  it('hides every view of it when the user collapses the region', () => {
    // The panels are views of one element, so one answer covers them all: there
    // is no state in which the explorer is collapsed but the outline is not.
    for (const view of ['explorer', 'search', 'outline', 'symbols', 'math-symbols', 'snippets', 'problems']) {
      expect(sidebarShown({ visible: false, view, settingsOpen: false }), view).toBe(false);
    }
  });

  it('hides it when no view has been chosen', () => {
    // A visible sidebar with no view would be an empty panel, so it is not shown.
    expect(sidebarShown({ visible: true, view: null, settingsOpen: false })).toBe(false);
  });

  it('hides it while the settings pane occupies its slot', () => {
    // The pane replaces the sidebar and the editor. The stored request and the
    // chosen view both survive — closing settings brings the same view back —
    // but nothing is on screen meanwhile, and the toggle has to know that.
    expect(sidebarShown({ visible: true, view: 'outline', settingsOpen: true })).toBe(false);
  });

  it('is on screen in exactly one of the eight combinations', () => {
    // The control that reads this reports on/off, so the rule has to be on for
    // one combination and off for the rest — an accidental `true` here is a
    // control reporting a panel that is not on screen, which is the bug this
    // replaced. Stated as a count so it cannot pass by restating the formula.
    let shown = 0;
    for (const visible of [true, false]) {
      for (const view of ['explorer', null] as const) {
        for (const settingsOpen of [true, false]) {
          if (sidebarShown({ visible, view, settingsOpen })) shown += 1;
        }
      }
    }
    expect(shown).toBe(1);
  });
});

/**
 * The activity bar is the sidebar's own view switcher: the strip holds the
 * buttons for the views, so by default it cannot stay up once the region it
 * switches has been collapsed — that leaves the buttons for six panels on screen
 * with none of those panels rendered.
 *
 * `appearance.collapseActivityBarWithSidebar` is the way out, and these tests pin
 * both halves of it: tied together, and left independent.
 */
describe('when the activity bar is on screen', () => {
  const chrome = (sidebarRequested: boolean, activityBarEnabled = true, collapseWithSidebar = true) =>
    sidebarChromeVisible({ sidebarRequested, activityBarEnabled, collapseWithSidebar });

  it('comes down with the sidebar when the user collapses it', () => {
    expect(chrome(true), 'showing').toBe(true);
    expect(chrome(false), 'collapsed').toBe(false);
  });

  it('stays up when no view has been chosen', () => {
    // Nothing has been collapsed in this state — the region is withheld because
    // it would be empty, and the strip is how a view gets chosen. That is also
    // why the rule reads the *request* rather than `sidebarShown`.
    expect(chrome(true)).toBe(true);
  });

  it('is unaffected by the settings pane, which the strip does not consult', () => {
    // The pane replaces the sidebar's slot but does not alter the request, so a
    // sidebar that is wanted keeps its strip while Settings is up (a view is one
    // click from inside the pane) and a collapsed one stays collapsed — opening
    // Settings is not a request to bring the sidebar back.
    expect(chrome(true), 'wanted, pane open or not').toBe(true);
    expect(chrome(false), 'collapsed, pane open or not').toBe(false);
  });

  it('still obeys the setting that turns the strip off', () => {
    expect(chrome(true, false)).toBe(false);
    expect(chrome(false, false)).toBe(false);
  });

  it('is on screen in exactly one of the four combinations', () => {
    let visible = 0;
    for (const sidebarRequested of [true, false]) {
      for (const activityBarEnabled of [true, false]) {
        if (sidebarChromeVisible({ sidebarRequested, activityBarEnabled, collapseWithSidebar: true })) visible += 1;
      }
    }
    expect(visible).toBe(1);
  });
});

/**
 * The two behaviours the setting chooses between. They answer different
 * questions, which is why the choice is worth offering: collapsing the sidebar
 * *whole* keeps the window free of controls for panels that are not showing,
 * while leaving the strip keeps the sidebar one click away.
 */
describe('collapsing only the container, not the strip', () => {
  const chrome = (sidebarRequested: boolean, activityBarEnabled = true) =>
    sidebarChromeVisible({ sidebarRequested, activityBarEnabled, collapseWithSidebar: false });

  it('leaves the strip up when the sidebar is collapsed', () => {
    // The point of the setting: the strip is the click target that brings the
    // sidebar back, so it survives the collapse it would otherwise follow.
    expect(chrome(false), 'collapsed, strip stays').toBe(true);
    expect(chrome(true), 'showing').toBe(true);
  });

  it('does not resurrect a strip the user has turned off', () => {
    // `appearance.showActivityBar` is a separate decision and still wins: a user
    // who turned the strip off does not get it back by leaving this one off too.
    expect(chrome(false, false)).toBe(false);
    expect(chrome(true, false)).toBe(false);
  });

  it('keeps the strip up regardless of which view is chosen', () => {
    // Only the request and the two settings matter; the strip is not a view.
    expect(chrome(false)).toBe(true);
  });
});
