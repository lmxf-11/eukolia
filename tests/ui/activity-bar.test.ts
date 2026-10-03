/**
 * The activity bar's selection rule.
 *
 * The strip is the only persistent control for the sidebar views, and it does two
 * jobs with one gesture: switching to a view, and dismissing the sidebar by
 * clicking the view already showing. That rule is the whole behaviour of the
 * component, so it is a function and it is tested here rather than through a DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_BAR_FOOTER,
  ACTIVITY_BAR_ITEMS,
  MENU_BAR_ITEM,
  PANEL_BUTTON_ITEMS,
  nextSidebarView
} from '@/ui/components/ActivityBar';

describe('activity bar selection', () => {
  it('switches to a different view', () => {
    expect(nextSidebarView('explorer', true, 'search')).toBe('search');
  });

  it('hides the sidebar when the active view is clicked again', () => {
    // The same control both switches and dismisses, which is what lets a 48px
    // strip do the job of a full sidebar header.
    expect(nextSidebarView('explorer', true, 'explorer')).toBeNull();
  });

  it('reveals the sidebar when a view is clicked while it is hidden', () => {
    // With the sidebar hidden there is no active view, so clicking any icon shows
    // that view rather than toggling.
    expect(nextSidebarView('explorer', false, 'explorer')).toBe('explorer');
    expect(nextSidebarView(null, false, 'outline')).toBe('outline');
  });

  it('does not treat a hidden sidebar as having an active view', () => {
    // `sidebarView` still holds the last view while the sidebar is hidden; the
    // rule must key off visibility, not off the stored view.
    expect(nextSidebarView('search', false, 'search')).toBe('search');
  });
});

describe('activity bar contents', () => {
  it('offers every sidebar view the application has', () => {
    const views = ACTIVITY_BAR_ITEMS.map((item) => item.view).filter(Boolean);
    expect(new Set(views)).toEqual(
      new Set(['menu', 'explorer', 'search', 'outline', 'symbols', 'snippets', 'problems'])
    );
  });

  it('gives every entry a label and an icon', () => {
    for (const item of [...ACTIVITY_BAR_ITEMS, ...ACTIVITY_BAR_FOOTER]) {
      expect(item.label.length, 'every entry needs a label for its tooltip').toBeGreaterThan(0);
      expect(item.icon, `${item.label} has no icon`).toBeTruthy();
    }
  });

  it('uses a command for entries that are not views', () => {
    // The foot of the strip holds commands, so an entry with no view must name a
    // command or it would do nothing when clicked.
    for (const item of ACTIVITY_BAR_FOOTER) {
      if (item.view === null) expect(item.command, `${item.label} has no command`).toBeTruthy();
    }
  });

  it('has no duplicate views', () => {
    const views = ACTIVITY_BAR_ITEMS.map((item) => item.view);
    expect(new Set(views).size).toBe(views.length);
  });

  it('separates the Menu button from the panel buttons', () => {
    expect(MENU_BAR_ITEM.view).toBe('menu');
    expect(MENU_BAR_ITEM.label).toBe('Menu');

    const panelViews = PANEL_BUTTON_ITEMS.map((item) => item.view);
    expect(panelViews).toEqual(['explorer', 'search', 'outline', 'symbols', 'snippets', 'problems']);
    expect(panelViews).not.toContain('menu');
  });
});
