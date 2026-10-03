/**
 * Eukolia — light-pdf command set and toolbar layout, ported.
 *
 * `LIGHTPDF_COMMANDS` transcribes the command *names* and descriptions from
 * `References/light-pdf/src/Commands.h` (the `Cmd*` enum values) and
 * `Commands.cpp` (`gCommandDescriptions`), and the shortcuts from
 * `Accelerators.cpp` (`gAccelerators`). Only the commands the PDF viewer can
 * actually perform are listed; the numeric ids are light-pdf's own so the
 * mapping is checkable.
 *
 * `LIGHTPDF_TOOLBAR` is a direct transcription of `Toolbar.cpp`'s
 * `gToolbarButtons[]` table — same entries, same order, same separators, same
 * tooltips. `TbIcon::None` with a non-zero command id is light-pdf's "page
 * info" pseudo-button (the page number box); `TbIcon::None` with id 0 is a
 * separator (see `SkipBuiltInButton`).
 */

import { TbIcon } from './lightpdf-icons';

/** `Commands.h` — the `Cmd*` values used by the viewer, in light-pdf's own order. */
export const LIGHTPDF_CMD = {
  CmdOpenFile: 201,
  CmdPrint: 209,
  CmdReloadDocument: 214,
  CmdProperties: 217,
  CmdSinglePageView: 218,
  CmdFacingView: 219,
  CmdBookView: 220,
  CmdToggleContinuousView: 221,
  CmdRotateLeft: 223,
  CmdRotateRight: 224,
  CmdToggleBookmarks: 225,
  CmdToggleTableOfContents: 226,
  CmdToggleFullscreen: 227,
  CmdToggleToolbar: 231,
  CmdChangeScrollbar: 232,
  CmdCopySelection: 234,
  CmdSelectAll: 241,
  CmdCopyFilePath: 248,
  CmdScrollUp: 249,
  CmdScrollDown: 250,
  CmdScrollLeft: 251,
  CmdScrollRight: 252,
  CmdScrollLeftPage: 253,
  CmdScrollRightPage: 254,
  CmdScrollUpPage: 255,
  CmdScrollDownPage: 256,
  CmdScrollDownHalfPage: 257,
  CmdScrollUpHalfPage: 258,
  CmdGoToNextPage: 259,
  CmdGoToPrevPage: 260,
  CmdGoToFirstPage: 261,
  CmdGoToLastPage: 262,
  CmdGoToPage: 263,
  CmdFindFirst: 264,
  CmdFindNext: 265,
  CmdFindPrev: 266,
  CmdFindNextSel: 267,
  CmdFindPrevSel: 268,
  CmdFindToggleMatchCase: 269,
  CmdZoomFitPage: 275,
  CmdZoomActualSize: 276,
  CmdZoomFitWidth: 277,
  CmdZoomFitByOrientation: 278,
  CmdZoomFitContent: 292,
  CmdZoomShrinkToFit: 293,
  CmdZoomCustom: 294,
  CmdZoomIn: 295,
  CmdZoomOut: 296,
  CmdZoomFitWidthAndContinuous: 297,
  CmdZoomFitPageAndSinglePage: 298,
  CmdToggleLinks: 338,
  CmdInvertColors: 360,
  CmdTogglePageInfo: 361,
  CmdToggleZoom: 362,
  CmdNavigateBack: 363,
  CmdNavigateForward: 364,
  CmdToggleCursorPosition: 365,
  CmdReadAloud: 416,
  CmdStartAutoScroll: 427,
  CmdFindToggleMatchWholeWord: 434,
  CmdToggleLightDarkTheme: 445
} as const;

export type LightPdfCommandId = (typeof LIGHTPDF_CMD)[keyof typeof LIGHTPDF_CMD];

export interface LightPdfCommand {
  id: LightPdfCommandId;
  /** `Commands.cpp` — `gCommandDescriptions`. */
  description: string;
  /** `Accelerators.cpp` — the first binding light-pdf registers, if any. */
  accelerator?: string;
}

/** `Commands.cpp` — `gCommandDescriptions` + `Accelerators.cpp` — `gAccelerators`. */
export const LIGHTPDF_COMMANDS: readonly LightPdfCommand[] = [
  { id: LIGHTPDF_CMD.CmdOpenFile, description: 'Open File...', accelerator: 'Ctrl+O' },
  { id: LIGHTPDF_CMD.CmdPrint, description: 'Print Document...', accelerator: 'Ctrl+P' },
  { id: LIGHTPDF_CMD.CmdReloadDocument, description: 'Reload Document', accelerator: 'R' },
  // `Accelerators.cpp:231` — `Ctrl+D`.
  { id: LIGHTPDF_CMD.CmdProperties, description: 'Show Document Properties...', accelerator: 'Ctrl+D' },
  // `Accelerators.cpp:252-257` — `Ctrl+6` / `Ctrl+7` / `Ctrl+8` and their numpad twins.
  { id: LIGHTPDF_CMD.CmdSinglePageView, description: 'Single Page View', accelerator: 'Ctrl+6' },
  { id: LIGHTPDF_CMD.CmdFacingView, description: 'Facing View', accelerator: 'Ctrl+7' },
  { id: LIGHTPDF_CMD.CmdBookView, description: 'Book View', accelerator: 'Ctrl+8' },
  { id: LIGHTPDF_CMD.CmdToggleContinuousView, description: 'Toggle Continuous View', accelerator: 'C' },
  { id: LIGHTPDF_CMD.CmdRotateLeft, description: 'Rotate Left', accelerator: '[' },
  { id: LIGHTPDF_CMD.CmdRotateRight, description: 'Rotate Right', accelerator: ']' },
  // `Accelerators.cpp:275` — `F12`.
  { id: LIGHTPDF_CMD.CmdToggleBookmarks, description: 'Toggle Bookmarks', accelerator: 'F12' },
  { id: LIGHTPDF_CMD.CmdToggleTableOfContents, description: 'Toggle Table Of Contents' },
  { id: LIGHTPDF_CMD.CmdToggleFullscreen, description: 'Toggle Fullscreen', accelerator: 'F11' },
  // `Accelerators.cpp:267` — `F8`.
  { id: LIGHTPDF_CMD.CmdToggleToolbar, description: 'Toggle Toolbar', accelerator: 'F8' },
  { id: LIGHTPDF_CMD.CmdScrollUp, description: 'Scroll Up', accelerator: 'K' },
  { id: LIGHTPDF_CMD.CmdScrollDown, description: 'Scroll Down', accelerator: 'J' },
  { id: LIGHTPDF_CMD.CmdScrollLeft, description: 'Scroll Left', accelerator: 'H' },
  { id: LIGHTPDF_CMD.CmdScrollRight, description: 'Scroll Right', accelerator: 'L' },
  { id: LIGHTPDF_CMD.CmdScrollUpPage, description: 'Scroll Up One Page', accelerator: 'PageUp' },
  { id: LIGHTPDF_CMD.CmdScrollDownPage, description: 'Scroll Down One Page', accelerator: 'PageDown' },
  { id: LIGHTPDF_CMD.CmdScrollUpHalfPage, description: 'Scroll Up Half a Page', accelerator: 'Shift+ArrowUp' },
  { id: LIGHTPDF_CMD.CmdScrollDownHalfPage, description: 'Scroll Down Half a Page', accelerator: 'Shift+ArrowDown' },
  { id: LIGHTPDF_CMD.CmdScrollLeftPage, description: 'Scroll Left One Page', accelerator: 'Shift+ArrowLeft' },
  { id: LIGHTPDF_CMD.CmdScrollRightPage, description: 'Scroll Right One Page', accelerator: 'Shift+ArrowRight' },
  // `Commands.cpp` — "Change Scrollbar..." opens `Dialog_ChangeScrollbar`
  // (`LightDialogs.cpp`), the four-way `Scrollbars` picker. It has no default
  // accelerator in light-pdf either: the command palette is its surface.
  { id: LIGHTPDF_CMD.CmdChangeScrollbar, description: 'Change Scrollbar...' },
  { id: LIGHTPDF_CMD.CmdNavigateBack, description: 'Navigate Back', accelerator: 'Alt+Left' },
  { id: LIGHTPDF_CMD.CmdNavigateForward, description: 'Navigate Forward', accelerator: 'Alt+Right' },
  { id: LIGHTPDF_CMD.CmdGoToNextPage, description: 'Next Page', accelerator: 'N' },
  { id: LIGHTPDF_CMD.CmdGoToPrevPage, description: 'Previous Page', accelerator: 'P' },
  { id: LIGHTPDF_CMD.CmdGoToFirstPage, description: 'First Page' },
  { id: LIGHTPDF_CMD.CmdGoToLastPage, description: 'Last Page' },
  { id: LIGHTPDF_CMD.CmdGoToPage, description: 'Go to Page...' },
  { id: LIGHTPDF_CMD.CmdZoomFitWidthAndContinuous, description: 'Zoom: Fit Width And Continuous' },
  { id: LIGHTPDF_CMD.CmdZoomFitPageAndSinglePage, description: 'Zoom: Fit Page and Single Page' },
  { id: LIGHTPDF_CMD.CmdZoomFitPage, description: 'Zoom: Fit Page', accelerator: 'Ctrl+0' },
  { id: LIGHTPDF_CMD.CmdZoomFitWidth, description: 'Zoom: Fit Width', accelerator: 'Ctrl+2' },
  { id: LIGHTPDF_CMD.CmdZoomFitByOrientation, description: 'Zoom: Fit Page or Width by Orientation' },
  { id: LIGHTPDF_CMD.CmdZoomFitContent, description: 'Zoom: Fit Content', accelerator: 'Ctrl+3' },
  { id: LIGHTPDF_CMD.CmdZoomShrinkToFit, description: 'Zoom: Shrink To Fit' },
  { id: LIGHTPDF_CMD.CmdZoomCustom, description: 'Zoom: Custom...', accelerator: 'Ctrl+Y' },
  { id: LIGHTPDF_CMD.CmdZoomActualSize, description: 'Zoom: Actual Size', accelerator: 'Ctrl+1' },
  { id: LIGHTPDF_CMD.CmdZoomIn, description: 'Zoom In', accelerator: 'Ctrl+=' },
  { id: LIGHTPDF_CMD.CmdZoomOut, description: 'Zoom Out', accelerator: 'Ctrl+-' },
  { id: LIGHTPDF_CMD.CmdToggleZoom, description: 'Toggle Zoom', accelerator: 'Z' },
  // `CmdToggleLinks` has no default accelerator in light-pdf either: it lives in
  // the (debug-build) View menu and in the command palette
  // (`Accelerators.cpp` has no entry for it; `LightPDF.cpp:8496-8501` toggles
  // `gGlobalPrefs->showLinks`).
  { id: LIGHTPDF_CMD.CmdToggleLinks, description: 'Toggle Show Links' },
  { id: LIGHTPDF_CMD.CmdSelectAll, description: 'Select All', accelerator: 'Ctrl+A' },
  { id: LIGHTPDF_CMD.CmdCopySelection, description: 'Copy Selection', accelerator: 'Ctrl+C' },
  { id: LIGHTPDF_CMD.CmdCopyFilePath, description: 'Copy File Path' },
  { id: LIGHTPDF_CMD.CmdFindFirst, description: 'Find...', accelerator: 'Ctrl+F' },
  { id: LIGHTPDF_CMD.CmdFindNext, description: 'Find Next', accelerator: 'F3' },
  { id: LIGHTPDF_CMD.CmdFindPrev, description: 'Find Previous', accelerator: 'Shift+F3' },
  // `Accelerators.cpp:263-264` — `Ctrl+F3` / `Ctrl+Shift+F3`.
  { id: LIGHTPDF_CMD.CmdFindNextSel, description: 'Find Next Selection', accelerator: 'Ctrl+F3' },
  { id: LIGHTPDF_CMD.CmdFindPrevSel, description: 'Find Previous Selection', accelerator: 'Ctrl+Shift+F3' },
  { id: LIGHTPDF_CMD.CmdFindToggleMatchCase, description: 'Find: Toggle Match Case' },
  { id: LIGHTPDF_CMD.CmdFindToggleMatchWholeWord, description: 'Find: Toggle Match Whole Word' },
  { id: LIGHTPDF_CMD.CmdTogglePageInfo, description: 'Toggle Page Info', accelerator: 'I' },
  // `Accelerators.cpp:309` — `{FVIRTKEY, 'M', CmdToggleCursorPosition}`. The
  // command cycles the unit the cursor-position tip reports (pt → mm → in → off).
  { id: LIGHTPDF_CMD.CmdToggleCursorPosition, description: 'Toggle Cursor Position', accelerator: 'M' },
  // `Accelerators.cpp` has no entry for it: `StartAutoScrollAtCursor`
  // (`Canvas.cpp:1704-1710`) is how the palette reaches the middle-click
  // auto-scroll without a middle button.
  { id: LIGHTPDF_CMD.CmdStartAutoScroll, description: 'Start Auto-Scroll' },
  { id: LIGHTPDF_CMD.CmdInvertColors, description: 'Invert Colors', accelerator: 'Shift+I' },
  { id: LIGHTPDF_CMD.CmdReadAloud, description: 'Read Aloud' },
  { id: LIGHTPDF_CMD.CmdToggleLightDarkTheme, description: 'Toggle Light/Dark Theme' }
];

/**
 * `Toolbar.cpp`:
 * ```c++
 * constexpr int PageInfoId = (int)CmdLast + 16;
 * static ToolbarButtonInfo gToolbarButtons[] = { ... };
 * ```
 * Reproduced entry for entry.
 */
export const PageInfoId = 'page-info';

/**
 * `FindBar.cpp` — `kFindBarCloseCmdId = (int)CmdLast + 50`, the command the find
 * bar's close button sends. It is a window command rather than a `Cmd*` one, so
 * it is modelled the same way as `PageInfoId`.
 */
export const FindBarCloseId = 'find-bar-close';

export interface LightPdfToolbarEntry {
  icon: TbIcon;
  /** `null` for a separator, matching light-pdf's `{TbIcon::None, 0, nullptr}`. */
  command: LightPdfCommandId | typeof PageInfoId | null;
  /** `Toolbar.cpp` — the `toolTip` field of `gToolbarButtons`. */
  toolTip: string | null;
}

export const LIGHTPDF_TOOLBAR: readonly LightPdfToolbarEntry[] = [
  { icon: TbIcon.Open, command: LIGHTPDF_CMD.CmdOpenFile, toolTip: 'Open' },
  { icon: TbIcon.Print, command: LIGHTPDF_CMD.CmdPrint, toolTip: 'Print' },
  { icon: TbIcon.None, command: PageInfoId, toolTip: null }, // text box for page number + show current page / no of pages
  { icon: TbIcon.PagePrev, command: LIGHTPDF_CMD.CmdGoToPrevPage, toolTip: 'Previous Page' },
  { icon: TbIcon.PageNext, command: LIGHTPDF_CMD.CmdGoToNextPage, toolTip: 'Next Page' },
  { icon: TbIcon.None, command: null, toolTip: null }, // separator
  { icon: TbIcon.NavigateBack, command: LIGHTPDF_CMD.CmdNavigateBack, toolTip: 'Back' },
  { icon: TbIcon.NavigateForward, command: LIGHTPDF_CMD.CmdNavigateForward, toolTip: 'Forward' },
  { icon: TbIcon.None, command: null, toolTip: null }, // separator
  { icon: TbIcon.Speak, command: LIGHTPDF_CMD.CmdReadAloud, toolTip: 'Read Aloud' },
  { icon: TbIcon.None, command: null, toolTip: null }, // separator
  {
    icon: TbIcon.LayoutContinuous,
    command: LIGHTPDF_CMD.CmdZoomFitWidthAndContinuous,
    toolTip: 'Fit Width and Show Pages Continuously'
  },
  { icon: TbIcon.LayoutSinglePage, command: LIGHTPDF_CMD.CmdZoomFitPageAndSinglePage, toolTip: 'Fit a Single Page' },
  { icon: TbIcon.RotateLeft, command: LIGHTPDF_CMD.CmdRotateLeft, toolTip: 'Rotate &Left' },
  { icon: TbIcon.RotateRight, command: LIGHTPDF_CMD.CmdRotateRight, toolTip: 'Rotate &Right' },
  { icon: TbIcon.ZoomOut, command: LIGHTPDF_CMD.CmdZoomOut, toolTip: 'Zoom Out' },
  { icon: TbIcon.ZoomIn, command: LIGHTPDF_CMD.CmdZoomIn, toolTip: 'Zoom In' },
  { icon: TbIcon.None, command: null, toolTip: null }, // separator
  { icon: TbIcon.Search, command: LIGHTPDF_CMD.CmdFindFirst, toolTip: 'Find' }
];

/**
 * `Toolbar.cpp` — `FindBarWnd::Create` adds a small toolbar with exactly these
 * six buttons. The last one (`ArrowsDiagonal`, "Open in a window") has no
 * Eukolia equivalent and is therefore not reproduced — see `LightPdfFindBar`.
 *
 * The close button's command is `kFindBarCloseCmdId` (`CmdLast + 50`), not a
 * `Cmd*` value; it is tagged with `FindBarCloseId` so clicking it can never be
 * mistaken for `CmdFindPrev`.
 */
export const LIGHTPDF_FIND_BAR_BUTTONS: readonly { icon: TbIcon; command: LightPdfCommandId | typeof FindBarCloseId; toolTip: string }[] = [
  { icon: TbIcon.ChevronUp, command: LIGHTPDF_CMD.CmdFindPrev, toolTip: 'Find Previous' },
  { icon: TbIcon.ChevronDown, command: LIGHTPDF_CMD.CmdFindNext, toolTip: 'Find Next' },
  { icon: TbIcon.MatchCase, command: LIGHTPDF_CMD.CmdFindToggleMatchCase, toolTip: 'Match Case' },
  { icon: TbIcon.MatchWholeWord, command: LIGHTPDF_CMD.CmdFindToggleMatchWholeWord, toolTip: 'Match Whole Word' },
  { icon: TbIcon.Close, command: FindBarCloseId, toolTip: 'Close' }
];

/** Finds a transcribed command by id. */
export function lightPdfCommand(id: number): LightPdfCommand | undefined {
  return LIGHTPDF_COMMANDS.find((command) => command.id === id);
}

/** `Toolbar.cpp` — the tooltip plus the command's accelerator, e.g. `"Next Page (N)"`. */
export function lightPdfToolTipWithAccelerator(id: number, base: string): string {
  const command = lightPdfCommand(id);
  return command?.accelerator ? `${base} (${command.accelerator})` : base;
}
