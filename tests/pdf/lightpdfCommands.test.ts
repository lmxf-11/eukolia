/**
 * The document commands light-pdf binds to keys and lists in its Zoom and View
 * menus, and that this port now performs: the three view layouts (`Ctrl+6/7/8`),
 * "Zoom: Custom..." (`Ctrl+Y`), shrink-to-fit, fit-by-orientation, the
 * selection searches (`Ctrl+F3` / `Ctrl+Shift+F3`), the toolbar and bookmarks
 * toggles (`F8` / `F12`), reload (`R`), properties (`Ctrl+D`) and the link
 * rectangles.
 *
 * Every id is light-pdf's own (`Commands.h`, generated from
 * `cmd/gen-commands.ts`), so the numbering is asserted here as well: a wrong id
 * would silently dispatch a different command once the two sides drift.
 */

import { describe, expect, it } from 'vitest';

import { LIGHTPDF_CMD, LIGHTPDF_COMMANDS, lightPdfCommand } from '@/pdf/lightpdf-commands';
import { LIGHTPDF_VIEWER_ACCELERATORS, matchViewerAccelerator, runViewerCommand, type LightPdfViewerActions } from '@/pdf/lightpdf-keyboard';

const press = (key: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key,
  ctrlKey: Boolean(modifiers.ctrl),
  shiftKey: Boolean(modifiers.shift),
  altKey: Boolean(modifiers.alt),
  metaKey: false
});

const recorder = () => {
  const calls: string[] = [];
  const actions: LightPdfViewerActions = {
    scrollBy: (d) => calls.push(`scrollBy:${d}`),
    scrollByPage: (d) => calls.push(`scrollByPage:${d}`),
    scrollHorizontally: (d) => calls.push(`scrollHorizontally:${d}`),
    scrollHorizontallyPage: (d) => calls.push(`scrollHorizontallyPage:${d}`),
    goToPage: (p) => calls.push(`goToPage:${p}`),
    nextPage: () => calls.push('nextPage'),
    previousPage: () => calls.push('previousPage'),
    firstPage: () => calls.push('firstPage'),
    lastPage: () => calls.push('lastPage'),
    navigateBack: () => calls.push('navigateBack'),
    navigateForward: () => calls.push('navigateForward'),
    setZoomMode: (m) => calls.push(`setZoomMode:${m}`),
    setZoom: (z) => calls.push(`setZoom:${z}`),
    getZoom: () => 2,
    fitContent: () => calls.push('fitContent'),
    rotate: (d) => calls.push(`rotate:${d}`),
    openFind: () => calls.push('openFind'),
    findNext: () => calls.push('findNext'),
    findPrevious: () => calls.push('findPrevious'),
    selectAll: () => calls.push('selectAll'),
    copySelection: () => {
      calls.push('copySelection');
      return true;
    },
    toggleContinuous: () => calls.push('toggleContinuous'),
    toggleZoom: () => calls.push('toggleZoom'),
    invertColors: () => calls.push('invertColors'),
    togglePageInfo: () => calls.push('togglePageInfo'),
    promptForPage: (count) => calls.push(`promptForPage:${count}`),
    pageCount: () => 7,
    setDisplayMode: (mode) => calls.push(`setDisplayMode:${mode}`),
    promptForZoom: () => calls.push('promptForZoom'),
    findSelection: (direction) => calls.push(`findSelection:${direction}`),
    toggleToolbar: () => calls.push('toggleToolbar'),
    toggleBookmarks: () => calls.push('toggleBookmarks'),
    toggleLinks: () => calls.push('toggleLinks'),
    copyFilePath: () => calls.push('copyFilePath'),
    reloadDocument: () => calls.push('reloadDocument'),
    showProperties: () => calls.push('showProperties'),
    // The auto-scroll, cursor-position, scrollbar and whole-word-find actions
    // added with the light-pdf gap-settings work. Recorded like the rest so a
    // command that reaches them is visible in `calls` rather than silent.
    toggleAutoScroll: () => calls.push('toggleAutoScroll'),
    toggleCursorPosition: () => calls.push('toggleCursorPosition'),
    changeScrollbar: () => calls.push('changeScrollbar'),
    toggleFindWholeWord: () => calls.push('toggleFindWholeWord')
  };
  return { calls, actions };
};

describe('command ids are light-pdf\'s own', () => {
  it('numbers the newly wired commands exactly as `Commands.h` does', () => {
    // `cmd/gen-commands.ts` assigns 201 + the index in its list.
    expect(LIGHTPDF_CMD.CmdReloadDocument).toBe(214);
    expect(LIGHTPDF_CMD.CmdProperties).toBe(217);
    expect(LIGHTPDF_CMD.CmdSinglePageView).toBe(218);
    expect(LIGHTPDF_CMD.CmdFacingView).toBe(219);
    expect(LIGHTPDF_CMD.CmdBookView).toBe(220);
    expect(LIGHTPDF_CMD.CmdToggleBookmarks).toBe(225);
    expect(LIGHTPDF_CMD.CmdToggleTableOfContents).toBe(226);
    expect(LIGHTPDF_CMD.CmdToggleToolbar).toBe(231);
    expect(LIGHTPDF_CMD.CmdCopyFilePath).toBe(248);
    expect(LIGHTPDF_CMD.CmdFindNextSel).toBe(267);
    expect(LIGHTPDF_CMD.CmdFindPrevSel).toBe(268);
    expect(LIGHTPDF_CMD.CmdZoomFitByOrientation).toBe(278);
    expect(LIGHTPDF_CMD.CmdZoomShrinkToFit).toBe(293);
    expect(LIGHTPDF_CMD.CmdZoomCustom).toBe(294);
    expect(LIGHTPDF_CMD.CmdToggleLinks).toBe(338);
  });

  it('gives every transcribed command light-pdf\'s description', () => {
    expect(lightPdfCommand(LIGHTPDF_CMD.CmdSinglePageView)?.description).toBe('Single Page View');
    expect(lightPdfCommand(LIGHTPDF_CMD.CmdZoomCustom)?.description).toBe('Zoom: Custom...');
    expect(lightPdfCommand(LIGHTPDF_CMD.CmdZoomShrinkToFit)?.description).toBe('Zoom: Shrink To Fit');
    expect(lightPdfCommand(LIGHTPDF_CMD.CmdToggleToolbar)?.description).toBe('Toggle Toolbar');
    expect(lightPdfCommand(LIGHTPDF_CMD.CmdToggleBookmarks)?.description).toBe('Toggle Bookmarks');
    expect(lightPdfCommand(LIGHTPDF_CMD.CmdProperties)?.description).toBe('Show Document Properties...');
  });

  it('describes every id in the table exactly once', () => {
    const ids = LIGHTPDF_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const accelerator of LIGHTPDF_VIEWER_ACCELERATORS) {
      expect(lightPdfCommand(accelerator.command), `no description for ${accelerator.command}`).toBeDefined();
    }
  });
});

describe('the view-layout accelerators — `Ctrl+6/7/8`', () => {
  it('matches light-pdf\'s three layout keys', () => {
    expect(matchViewerAccelerator(press('6', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdSinglePageView);
    expect(matchViewerAccelerator(press('7', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdFacingView);
    expect(matchViewerAccelerator(press('8', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdBookView);
  });

  it('switches the layout rather than the zoom', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdSinglePageView, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdFacingView, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdBookView, actions);
    expect(calls).toEqual(['setDisplayMode:single-page', 'setDisplayMode:facing', 'setDisplayMode:book']);
  });
});

describe('zoom commands', () => {
  it('binds `Ctrl+Y` to the custom-zoom prompt and `Ctrl+F3` to the selection searches', () => {
    expect(matchViewerAccelerator(press('y', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdZoomCustom);
    expect(matchViewerAccelerator(press('F3', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdFindNextSel);
    expect(matchViewerAccelerator(press('F3', { ctrl: true, shift: true }))).toBe(LIGHTPDF_CMD.CmdFindPrevSel);
    // …while the plain and shifted F3 stay "find next/previous".
    expect(matchViewerAccelerator(press('F3'))).toBe(LIGHTPDF_CMD.CmdFindNext);
    expect(matchViewerAccelerator(press('F3', { shift: true }))).toBe(LIGHTPDF_CMD.CmdFindPrev);
  });

  it('applies shrink-to-fit and fit-by-orientation as zoom modes', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdZoomShrinkToFit, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdZoomFitByOrientation, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdZoomCustom, actions);
    expect(calls).toEqual(['setZoomMode:shrink-to-fit', 'setZoomMode:auto', 'promptForZoom']);
  });

  it('searches for the selection in the requested direction', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdFindNextSel, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdFindPrevSel, actions);
    expect(calls).toEqual(['findSelection:1', 'findSelection:-1']);
  });
});

describe('view toggles and document commands', () => {
  it('binds `F8` to the toolbar and `F12` to the bookmarks', () => {
    expect(matchViewerAccelerator(press('F8'))).toBe(LIGHTPDF_CMD.CmdToggleToolbar);
    expect(matchViewerAccelerator(press('F12'))).toBe(LIGHTPDF_CMD.CmdToggleBookmarks);
  });

  it('binds `R` to reload and `Ctrl+D` to the properties window', () => {
    expect(matchViewerAccelerator(press('r'))).toBe(LIGHTPDF_CMD.CmdReloadDocument);
    expect(matchViewerAccelerator(press('d', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdProperties);
    // `Ctrl+R` is the shell's, so the viewer must not claim it.
    expect(matchViewerAccelerator(press('r', { ctrl: true }))).toBeNull();
  });

  it('copies on `Ctrl+Insert` as well as `Ctrl+C`, as light-pdf does', () => {
    expect(matchViewerAccelerator(press('Insert', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdCopySelection);
  });

  it('runs the toggles and the document commands', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdToggleToolbar, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdToggleBookmarks, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdToggleLinks, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdCopyFilePath, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdReloadDocument, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdProperties, actions);
    expect(calls).toEqual([
      'toggleToolbar',
      'toggleBookmarks',
      'toggleLinks',
      'copyFilePath',
      'reloadDocument',
      'showProperties'
    ]);
  });
});

describe('commands this port still cannot perform', () => {
  it('leaves the key to the application when a command is unsupported', () => {
    const { actions } = recorder();
    // No printing pipeline, no text-to-speech, no fullscreen or presentation
    // mode in the renderer: these must not swallow their keys.
    expect(runViewerCommand(LIGHTPDF_CMD.CmdPrint, actions)).toBe(false);
    expect(runViewerCommand(LIGHTPDF_CMD.CmdReadAloud, actions)).toBe(false);
    expect(runViewerCommand(LIGHTPDF_CMD.CmdToggleFullscreen, actions)).toBe(false);
  });

  it('does not bind F5, F11 or the presentation keys light-pdf uses', () => {
    // `CmdTogglePresentationMode` needs a fullscreen path the renderer does not
    // have, so its `F5`/`Ctrl+L`/`Shift+F11` bindings are deliberately absent.
    expect(matchViewerAccelerator(press('F5'))).toBeNull();
    expect(matchViewerAccelerator(press('F11'))).toBeNull();
    expect(matchViewerAccelerator(press('l', { ctrl: true }))).toBeNull();
  });
});
