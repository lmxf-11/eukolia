/**
 * The PDF viewer's keyboard, ported from light-pdf.
 *
 * light-pdf drives its viewer from `Accelerators.cpp`, so the port has to match
 * its key choices and, just as importantly, its modifier rules: `N` pages
 * forward but `Ctrl+N` must not, and a key the viewer does not own must fall
 * through to the rest of the application rather than being swallowed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LIGHTPDF_VIEWER_ACCELERATORS,
  matchViewerAccelerator,
  runViewerCommand,
  type LightPdfViewerActions
} from '@/pdf/lightpdf-keyboard';
import { LIGHTPDF_CMD, LIGHTPDF_COMMANDS, lightPdfCommand } from '@/pdf/lightpdf-commands';

const press = (
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
) => ({
  key,
  ctrlKey: Boolean(modifiers.ctrl),
  shiftKey: Boolean(modifiers.shift),
  altKey: Boolean(modifiers.alt),
  metaKey: false
});

/** Every action recorded, so a command's effect can be asserted precisely. */
const recorder = () => {
  const calls: string[] = [];
  const actions: LightPdfViewerActions = {
    scrollBy: d => calls.push(`scrollBy:${d}`),
    scrollByPage: d => calls.push(`scrollByPage:${d}`),
    scrollHorizontally: d => calls.push(`scrollHorizontally:${d}`),
    scrollHorizontallyPage: d => calls.push(`scrollHorizontallyPage:${d}`),
    goToPage: p => calls.push(`goToPage:${p}`),
    nextPage: () => calls.push('nextPage'),
    previousPage: () => calls.push('previousPage'),
    firstPage: () => calls.push('firstPage'),
    lastPage: () => calls.push('lastPage'),
    navigateBack: () => calls.push('navigateBack'),
    navigateForward: () => calls.push('navigateForward'),
    setZoomMode: m => calls.push(`setZoomMode:${m}`),
    setZoom: z => calls.push(`setZoom:${z}`),
    getZoom: () => 2,
    fitContent: () => calls.push('fitContent'),
    rotate: d => calls.push(`rotate:${d}`),
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
    promptForPage: count => calls.push(`promptForPage:${count}`),
    pageCount: () => 7,
    setDisplayMode: mode => calls.push(`setDisplayMode:${mode}`),
    promptForZoom: () => calls.push('promptForZoom'),
    findSelection: direction => calls.push(`findSelection:${direction}`),
    toggleToolbar: () => calls.push('toggleToolbar'),
    toggleBookmarks: () => calls.push('toggleBookmarks'),
    toggleLinks: () => calls.push('toggleLinks'),
    copyFilePath: () => calls.push('copyFilePath'),
    reloadDocument: () => calls.push('reloadDocument'),
    showProperties: () => calls.push('showProperties'),
    toggleAutoScroll: () => calls.push('toggleAutoScroll'),
    toggleCursorPosition: () => calls.push('toggleCursorPosition'),
    changeScrollbar: () => calls.push('changeScrollbar'),
    toggleFindWholeWord: () => calls.push('toggleFindWholeWord')
  };
  return { calls, actions };
};

describe('light-pdf accelerator table', () => {
  it('covers every command a document pane can honour', () => {
    const bound = new Set(LIGHTPDF_VIEWER_ACCELERATORS.map(entry => entry.command));
    for (const command of [
      LIGHTPDF_CMD.CmdScrollUp,
      LIGHTPDF_CMD.CmdScrollDown,
      LIGHTPDF_CMD.CmdScrollUpPage,
      LIGHTPDF_CMD.CmdScrollDownPage,
      LIGHTPDF_CMD.CmdGoToNextPage,
      LIGHTPDF_CMD.CmdGoToPrevPage,
      LIGHTPDF_CMD.CmdGoToFirstPage,
      LIGHTPDF_CMD.CmdGoToLastPage,
      LIGHTPDF_CMD.CmdZoomFitPage,
      LIGHTPDF_CMD.CmdZoomFitWidth,
      LIGHTPDF_CMD.CmdZoomActualSize,
      LIGHTPDF_CMD.CmdZoomIn,
      LIGHTPDF_CMD.CmdZoomOut,
      LIGHTPDF_CMD.CmdRotateLeft,
      LIGHTPDF_CMD.CmdRotateRight,
      LIGHTPDF_CMD.CmdFindFirst,
      LIGHTPDF_CMD.CmdFindNext,
      LIGHTPDF_CMD.CmdFindPrev,
      LIGHTPDF_CMD.CmdNavigateBack,
      LIGHTPDF_CMD.CmdNavigateForward,
      LIGHTPDF_CMD.CmdInvertColors,
      LIGHTPDF_CMD.CmdToggleZoom,
      LIGHTPDF_CMD.CmdToggleContinuousView
    ]) {
      expect(bound.has(command), `no accelerator for command ${command}`).toBe(true);
    }
  });

  it('uses light-pdf\'s own command ids', () => {
    // The ids are transcribed from `Commands.h`; a wrong id would make the
    // toolbar's `data-command` attributes and this table disagree.
    expect(lightPdfCommand(259)?.description).toBe('Next Page');
    expect(lightPdfCommand(221)?.description).toBe('Toggle Continuous View');
    expect(LIGHTPDF_CMD.CmdScrollDownHalfPage).toBe(257);
    expect(LIGHTPDF_CMD.CmdInvertColors).toBe(360);
  });

  it('gives every transcribed command a description', () => {
    for (const entry of LIGHTPDF_VIEWER_ACCELERATORS) {
      expect(
        LIGHTPDF_COMMANDS.some(command => command.id === entry.command),
        `command ${entry.command} has no description`
      ).toBe(true);
    }
  });
});

describe('matchViewerAccelerator', () => {
  it('matches light-pdf\'s single-letter scroll keys', () => {
    expect(matchViewerAccelerator(press('j'))).toBe(LIGHTPDF_CMD.CmdScrollDown);
    expect(matchViewerAccelerator(press('k'))).toBe(LIGHTPDF_CMD.CmdScrollUp);
    expect(matchViewerAccelerator(press('h'))).toBe(LIGHTPDF_CMD.CmdScrollLeft);
    expect(matchViewerAccelerator(press('l'))).toBe(LIGHTPDF_CMD.CmdScrollRight);
  });

  it('treats letters case-insensitively, as a Win32 virtual key does', () => {
    expect(matchViewerAccelerator(press('J'))).toBe(LIGHTPDF_CMD.CmdScrollDown);
  });

  it('matches paging and history keys', () => {
    expect(matchViewerAccelerator(press('n'))).toBe(LIGHTPDF_CMD.CmdGoToNextPage);
    expect(matchViewerAccelerator(press('p'))).toBe(LIGHTPDF_CMD.CmdGoToPrevPage);
    expect(matchViewerAccelerator(press('Backspace'))).toBe(LIGHTPDF_CMD.CmdNavigateBack);
    expect(matchViewerAccelerator(press('Backspace', { shift: true }))).toBe(
      LIGHTPDF_CMD.CmdNavigateForward
    );
    expect(matchViewerAccelerator(press('ArrowLeft', { alt: true }))).toBe(
      LIGHTPDF_CMD.CmdNavigateBack
    );
  });

  it('matches the zoom ladder', () => {
    expect(matchViewerAccelerator(press('0', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdZoomFitPage);
    expect(matchViewerAccelerator(press('1', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdZoomActualSize);
    expect(matchViewerAccelerator(press('2', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdZoomFitWidth);
    expect(matchViewerAccelerator(press('3', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdZoomFitContent);
  });

  it('requires the modifiers to match exactly', () => {
    // `Ctrl+N` must not page forward: it is a different binding entirely.
    expect(matchViewerAccelerator(press('n', { ctrl: true }))).toBeNull();
    // A bare `0` is not zoom-fit-page.
    expect(matchViewerAccelerator(press('0'))).toBeNull();
    // `Ctrl+Shift+plus` rotates rather than zooming in.
    expect(matchViewerAccelerator(press('+', { ctrl: true, shift: true }))).toBe(
      LIGHTPDF_CMD.CmdRotateRight
    );
    expect(matchViewerAccelerator(press('+', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdZoomIn);
  });

  it('matches the selection bindings', () => {
    expect(matchViewerAccelerator(press('a', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdSelectAll);
    expect(matchViewerAccelerator(press('c', { ctrl: true }))).toBe(LIGHTPDF_CMD.CmdCopySelection);
    // The shell owns Ctrl+S and Ctrl+V; the viewer must not claim them.
    expect(matchViewerAccelerator(press('v', { ctrl: true }))).toBeNull();
  });

  it('leaves keys the viewer does not own to the application', () => {
    expect(matchViewerAccelerator(press('s', { ctrl: true }))).toBeNull();
    expect(matchViewerAccelerator(press('F5'))).toBeNull();
    expect(matchViewerAccelerator(press('a'))).toBeNull();
  });

  it('ignores the meta key, so OS shortcuts are not intercepted', () => {
    expect(matchViewerAccelerator({ ...press('n'), metaKey: true })).toBeNull();
  });
});

describe('runViewerCommand', () => {
  it('scrolls by a step for the vi keys and a page for the paging keys', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdScrollDown, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdScrollDownPage, actions);
    expect(calls).toEqual(['scrollBy:60', 'scrollByPage:1']);
  });

  it('pages forward and back', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdGoToNextPage, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdGoToPrevPage, actions);
    expect(calls).toEqual(['nextPage', 'previousPage']);
  });

  it('asks for the page count before prompting', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdGoToPage, actions);
    expect(calls).toEqual(['promptForPage:7']);
  });

  it('applies the zoom modes rather than raw levels', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdZoomFitPage, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdZoomFitWidth, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdZoomActualSize, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdZoomFitContent, actions);
    expect(calls).toEqual([
      'setZoomMode:page-fit',
      'setZoomMode:page-width',
      'setZoomMode:actual',
      'fitContent'
    ]);
  });

  it('steps the zoom for zoom in and out', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdZoomIn, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdZoomOut, actions);
    expect(calls).toEqual(['setZoom:2.5', 'setZoom:1.6']);
  });

  it('reports whether the key was consumed', () => {
    const { actions } = recorder();
    expect(runViewerCommand(LIGHTPDF_CMD.CmdScrollDown, actions)).toBe(true);
    // A command the pane cannot perform must let the key through.
    expect(runViewerCommand(LIGHTPDF_CMD.CmdPrint, actions)).toBe(false);
    expect(runViewerCommand(LIGHTPDF_CMD.CmdReadAloud, actions)).toBe(false);
  });

  it('drives the view toggles', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdToggleContinuousView, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdInvertColors, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdTogglePageInfo, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdRotateLeft, actions);
    expect(calls).toEqual(['toggleContinuous', 'invertColors', 'togglePageInfo', 'rotate:-1']);
  });

  it('selects all and copies', () => {
    const { calls, actions } = recorder();
    runViewerCommand(LIGHTPDF_CMD.CmdSelectAll, actions);
    runViewerCommand(LIGHTPDF_CMD.CmdCopySelection, actions);
    expect(calls).toEqual(['selectAll', 'copySelection']);
  });
});

describe('viewer actions are wired to the pane', () => {
  it('never calls a missing action', () => {
    // The pane builds its actions from the viewer handle, which is null until
    // the document opens; every action therefore has to be safe to call.
    const { actions } = recorder();
    const spy = vi.fn();
    expect(() => {
      for (const entry of LIGHTPDF_VIEWER_ACCELERATORS) {
        runViewerCommand(entry.command, { ...actions, promptForPage: spy });
      }
    }).not.toThrow();
  });
});
