/**
 * Eukolia — light-pdf's toolbar and find bar, ported to React.
 *
 * The button row is generated from `LIGHTPDF_TOOLBAR`, the transcription of
 * `Toolbar.cpp`'s `gToolbarButtons[]`, so the order, the icon choice, the
 * tooltips and the separators are light-pdf's, not a new arrangement. Entries
 * whose command Eukolia cannot perform are dropped (see
 * `IMPLEMENTED_COMMANDS`) rather than rendered as dead controls
 * (`Instructions.md` §72): light-pdf's Print and Read Aloud have no Eukolia
 * equivalent yet.
 *
 * Visual parameters follow the ported theme and toolbar metrics:
 * - bar background `ThemeControlBackgroundColor()`, bottom edge
 *   `AccentColor(ctrlBg, 40)` — light-pdf sets `DarkMode::setEdgeColor` to
 *   exactly that in `SetThemeByIndex`;
 * - button hover `AccentColor(ctrlBg, 20)` (`DarkMode::setHotBackgroundColor`);
 * - icons rendered from `SvgIcons.cpp` at `Toolbar.cpp`'s `kDefaultIconSize`
 *   (18) inside the ~26px bar light-pdf's own toolbar screenshot measures.
 *
 * The find bar is `FindBar.cpp`'s floating `WS_POPUP | WS_BORDER` window: an
 * edit with the cue text "Find", an "n / m" status (`SearchAndDDE.cpp`,
 * `ShowMatchCount`) and the small button strip built in `FindBarWnd::Create`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSvgIcon, TbIcon } from './lightpdf-icons';
import {
  LIGHTPDF_CMD,
  LIGHTPDF_FIND_BAR_BUTTONS,
  LIGHTPDF_TOOLBAR,
  FindBarCloseId,
  PageInfoId,
  lightPdfToolTipWithAccelerator,
  type LightPdfToolbarEntry
} from './lightpdf-commands';
import type { LightPdfDisplayMode } from './lightpdf-layout';
import type { PdfZoomMode } from './PdfViewer';
import {
  LIGHTPDF_TOOLBAR_METRICS,
  accentColor,
  bgrToHex,
  lightPdfToolbarBarHeight,
  themeControlBackgroundColor,
  themeWindowLinkColor,
  themeWindowTextColor,
  themeWindowTextDisabledColor,
  type LightPdfThemeState
} from './lightpdf-theme';

/**
 * The white `FixedPageUI.BackgroundColor` input background light-pdf edits use.
 */
const INPUT_BACKGROUND = '#ffffff';

/**
 * The commands Eukolia's PDF pane actually performs. Everything outside this set
 * is hidden, exactly as `Toolbar.cpp`'s `IsCmdAvailable` hides a command with
 * `TBSTATE_HIDDEN` — and, as there, the button's *slot* and the separators around
 * it stay, so the row keeps light-pdf's grouping:
 *
 * `Open · [page box] Prev Next | Back Forward | | FitWidth FitSingle RotL RotR
 * ZoomOut ZoomIn | Find`
 *
 * Not implemented, and therefore hidden:
 * - `CmdPrint` (`Toolbar.cpp` icon `Print`) — Eukolia has no print pipeline.
 * - `CmdReadAloud` (icon `Speak`) — Eukolia has no text-to-speech.
 *
 * Hiding both is exactly what light-pdf does when those commands are
 * unavailable, and it leaves two adjacent separators where `Print` and
 * `Read Aloud` sat; collapsing them (dropping the buttons *and* their
 * separators) would be a different toolbar from the reference's.
 */
const IMPLEMENTED_COMMANDS: ReadonlySet<string | number> = new Set<string | number>([
  LIGHTPDF_CMD.CmdOpenFile,
  PageInfoId,
  LIGHTPDF_CMD.CmdGoToPrevPage,
  LIGHTPDF_CMD.CmdGoToNextPage,
  LIGHTPDF_CMD.CmdNavigateBack,
  LIGHTPDF_CMD.CmdNavigateForward,
  LIGHTPDF_CMD.CmdZoomFitWidthAndContinuous,
  LIGHTPDF_CMD.CmdZoomFitPageAndSinglePage,
  LIGHTPDF_CMD.CmdRotateLeft,
  LIGHTPDF_CMD.CmdRotateRight,
  LIGHTPDF_CMD.CmdZoomOut,
  LIGHTPDF_CMD.CmdZoomIn,
  LIGHTPDF_CMD.CmdFindFirst
]);

export type PdfLayoutZoomMode = PdfZoomMode;

export interface LightPdfToolbarProps {
  page: number;
  pageCount: number;
  /**
   * Whether the page box is shown. light-pdf's `CmdTogglePageInfo` (`I`) turns
   * it off, which is the one toolbar entry a command removes.
   */
  pageInfoVisible?: boolean;
  /** Current scale factor (1 = 100%). */
  zoom: number;
  zoomMode: PdfLayoutZoomMode;
  /** `params.displayMode` — the layout family the two layout buttons reflect. */
  displayMode: LightPdfDisplayMode;
  theme: LightPdfThemeState;
  /**
   * `ToolbarSize` (`gen-settings.ts:799`), the icon size in pixels. light-pdf's
   * `Toolbar.cpp:1281-1283` is explicit that the preference sizes the *icons*;
   * the bar is that box plus `kToolbarPaddingY` (`LIGHTPDF_TOOLBAR_METRICS`).
   */
  iconSize?: number;
  /**
   * Which side of the bar the edge line is on: light-pdf's rebar band draws its
   * separator against the document, so a bottom toolbar
   * (`ToolbarPosition = bottom`) has it on top.
   */
  edge?: 'top' | 'bottom';
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  findOpen: boolean;
  onOpenFile(): void;
  onGoToPage(page: number): void;
  onPreviousPage(): void;
  onNextPage(): void;
  onNavigateBack(): void;
  onNavigateForward(): void;
  onZoomFitWidthAndContinuous(): void;
  onZoomFitPageAndSinglePage(): void;
  onRotateLeft(): void;
  onRotateRight(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onToggleFind(): void;
}

export const LightPdfToolbar: React.FC<LightPdfToolbarProps> = (props) => {
  const { theme } = props;
  /**
   * `gToolbarButtons[]` in order. A command Eukolia cannot perform keeps its
   * slot but renders nothing, which is how `IsCmdAvailable` +
   * `UpdateToolbarButtonStateByIdx(..., TBSTATE_HIDDEN)` behave in the
   * reference, so the separators and the grouping do not move.
   */
  const entries = LIGHTPDF_TOOLBAR;

  /**
   * `ToolbarSize` sizes the icons, and the bar follows: light-pdf's rebar band is
   * the icon box plus its padding (`Toolbar.cpp:1402-1417`, where
   * `iconDy = RoundUp(DpiScale(iconSize), 4)`).
   */
  const iconSize = Math.max(8, Math.round(props.iconSize ?? LIGHTPDF_TOOLBAR_METRICS.defaultIconSize));
  const buttonSize = iconSize + 4;
  const barHeight = lightPdfToolbarBarHeight(iconSize);

  const controlBg = themeControlBackgroundColor(theme);
  const textColor = bgrToHex(themeWindowTextColor(theme));
  const disabledColor = bgrToHex(themeWindowTextDisabledColor(theme));
  const edgeColor = bgrToHex(accentColor(controlBg, 40));
  const hotColor = bgrToHex(accentColor(controlBg, 20));
  const linkColor = bgrToHex(themeWindowLinkColor(theme));

  const disabledFor = (command: string | number): boolean => {
    switch (command) {
      case LIGHTPDF_CMD.CmdGoToPrevPage:
        return props.page <= 1;
      case LIGHTPDF_CMD.CmdGoToNextPage:
        return props.pageCount > 0 && props.page >= props.pageCount;
      case LIGHTPDF_CMD.CmdNavigateBack:
        return !props.canNavigateBack;
      case LIGHTPDF_CMD.CmdNavigateForward:
        return !props.canNavigateForward;
      case LIGHTPDF_CMD.CmdZoomIn:
      case LIGHTPDF_CMD.CmdZoomOut:
        // light-pdf disables zoom when there is nothing to zoom.
        return props.pageCount === 0;
      default:
        return false;
    }
  };

  /**
   * `Toolbar.cpp` — `SetToolbarButtonCheckedState`. Only the two layout buttons
   * are ever checked on the document toolbar: "fit width and continuous" while
   * the document is continuous *and* fit to width, "fit a single page" while it
   * is single-page *and* fit to page (that pair is what `ChangeZoomLevel` sets).
   * No other button in the row has a checked state — the Find button included.
   */
  const checkedFor = (command: string | number): boolean => {
    const continuous = props.displayMode === 'continuous';
    if (command === LIGHTPDF_CMD.CmdZoomFitWidthAndContinuous) return props.zoomMode === 'page-width' && continuous;
    if (command === LIGHTPDF_CMD.CmdZoomFitPageAndSinglePage) return props.zoomMode === 'page-fit' && props.displayMode === 'single-page';
    return false;
  };

  const run = (command: string | number): void => {
    switch (command) {
      case LIGHTPDF_CMD.CmdOpenFile:
        props.onOpenFile();
        break;
      case LIGHTPDF_CMD.CmdGoToPrevPage:
        props.onPreviousPage();
        break;
      case LIGHTPDF_CMD.CmdGoToNextPage:
        props.onNextPage();
        break;
      case LIGHTPDF_CMD.CmdNavigateBack:
        props.onNavigateBack();
        break;
      case LIGHTPDF_CMD.CmdNavigateForward:
        props.onNavigateForward();
        break;
      case LIGHTPDF_CMD.CmdZoomFitWidthAndContinuous:
        props.onZoomFitWidthAndContinuous();
        break;
      case LIGHTPDF_CMD.CmdZoomFitPageAndSinglePage:
        props.onZoomFitPageAndSinglePage();
        break;
      case LIGHTPDF_CMD.CmdRotateLeft:
        props.onRotateLeft();
        break;
      case LIGHTPDF_CMD.CmdRotateRight:
        props.onRotateRight();
        break;
      case LIGHTPDF_CMD.CmdZoomOut:
        props.onZoomOut();
        break;
      case LIGHTPDF_CMD.CmdZoomIn:
        props.onZoomIn();
        break;
      case LIGHTPDF_CMD.CmdFindFirst:
        props.onToggleFind();
        break;
      default:
        break;
    }
  };

  return (
    <div
      data-testid="pdf-toolbar"
      data-theme={theme.theme.name}
      // The page count the pane is working from. The page box holds a local
      // draft while it is being typed into, so it cannot report this, and a
      // command that navigates by page number depends on this value.
      data-page-count={props.pageCount}
      // Deliberately *not* `data-page`: that name marks a page element inside
      // the scroll container, so a toolbar carrying it too made every
      // `[data-page]` query count the toolbar as an extra page — two pages read
      // as `[1, 2, 2]` and navigation tests failed on a viewer that was correct.
      data-pane-page={props.page}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        height: barHeight,
        padding: '0 4px',
        gap: LIGHTPDF_TOOLBAR_METRICS.buttonSpacingX,
        background: bgrToHex(controlBg),
        color: textColor,
        borderTop: props.edge === 'top' ? `1px solid ${edgeColor}` : undefined,
        borderBottom: props.edge === 'top' ? undefined : `1px solid ${edgeColor}`,
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: 12,
        userSelect: 'none'
      }}
    >
      {/* `SvgIcons.cpp` draws a 24×24 viewBox; the toolbar renders it at
          `kDefaultIconSize` (18), so the outer svg box is overridden by CSS. */}
      <style>{`
        [data-testid="pdf-toolbar"] svg, [data-testid="pdf-find-bar"] svg { display: block; width: 100%; height: 100%; }
      `}</style>
      {entries.map((entry, index) => {
        if (entry.command === null) {
          // `Toolbar.cpp` — `BTNS_SEP`: a short vertical rule.
          return <div key={`sep-${index}`} style={{ width: 1, height: Math.round(iconSize * 0.9), background: edgeColor, margin: '0 2px' }} />;
        }
        // A command this port cannot perform is hidden, not removed: its slot
        // stays so the separators around it keep light-pdf's grouping.
        if (!IMPLEMENTED_COMMANDS.has(entry.command)) return null;
        if (entry.command === PageInfoId) {
          // `CmdTogglePageInfo` (`Toolbar.cpp` — `I`) hides the page box; the
          // entry is skipped rather than emptied so the buttons beside it keep
          // their positions.
          if (props.pageInfoVisible === false) return null;
          return (
            <PageBox
              key="page-info"
              page={props.page}
              pageCount={props.pageCount}
              textColor={textColor}
              edgeColor={edgeColor}
              onGoToPage={props.onGoToPage}
            />
          );
        }

        const command = entry.command;
        return (
          <ToolbarButton
            key={`${String(command)}-${index}`}
            command={command}
            title={entry.toolTip ? lightPdfToolTipWithAccelerator(command, entry.toolTip) : undefined}
            iconSvg={getSvgIcon(entry.icon)}
            disabled={disabledFor(command)}
            checked={checkedFor(command)}
            iconSize={iconSize}
            buttonSize={buttonSize}
            textColor={textColor}
            disabledColor={disabledColor}
            hotColor={hotColor}
            linkColor={linkColor}
            onClick={() => run(command)}
          />
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const ToolbarButton: React.FC<{
  /** light-pdf's `idCommand`, exposed so the find bar can anchor under it. */
  command?: string | number;
  title?: string;
  iconSvg: string | null;
  disabled: boolean;
  checked: boolean;
  /** `ToolbarSize` — the icon box, in pixels. */
  iconSize?: number;
  /** The button box: the icon plus its 4px padding. */
  buttonSize?: number;
  textColor: string;
  disabledColor: string;
  hotColor: string;
  linkColor: string;
  onClick(): void;
}> = ({ command, title, iconSvg, disabled, checked, iconSize = LIGHTPDF_TOOLBAR_METRICS.defaultIconSize, buttonSize = LIGHTPDF_TOOLBAR_METRICS.defaultIconSize + 4, textColor, disabledColor, hotColor, linkColor, onClick }) => {
  const [hover, setHover] = useState(false);
  const color = disabled ? disabledColor : checked ? linkColor : textColor;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={checked}
      data-command={command === undefined ? undefined : String(command)}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: buttonSize,
        height: buttonSize,
        padding: 0,
        border: 'none',
        borderRadius: 2,
        background: hover && !disabled ? hotColor : 'transparent',
        color,
        cursor: disabled ? 'default' : 'pointer',
        flexShrink: 0
      }}
    >
      {iconSvg && (
        <span
          style={{ display: 'block', width: iconSize, height: iconSize, color }}
          // The markup is `SvgIcons.cpp`'s own, verbatim; it is not user input.
          dangerouslySetInnerHTML={{ __html: iconSvg }}
        />
      )}
    </button>
  );
};

/**
 * `Toolbar.cpp` — `CreatePageBox` + `UpdateToolbarPageText`: the "Page:" label,
 * an `ES_NUMBER | ES_RIGHT` edit holding the current page, and the
 * `" / %d"` total (`fmt(" / %d", pageCount)`). Pressing Return runs
 * `CmdGoToPage`.
 */
const PageBox: React.FC<{
  page: number;
  pageCount: number;
  textColor: string;
  edgeColor: string;
  onGoToPage(page: number): void;
}> = ({ page, pageCount, textColor, edgeColor, onGoToPage }) => {
  const [draft, setDraft] = useState(String(page));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDraft(String(page));
  }, [page]);

  const commit = useCallback(() => {
    editingRef.current = false;
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed)) {
      onGoToPage(parsed);
      setDraft(String(parsed));
    } else {
      setDraft(String(page));
    }
  }, [draft, onGoToPage, page]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: LIGHTPDF_TOOLBAR_METRICS.buttonSpacingX, flexShrink: 0 }}>
      {/* `Toolbar.cpp` — `kTextPaddingRight` sits between the label and the edit. */}
      <span style={{ paddingRight: 2 }}>Page:</span>
      <input
        value={draft}
        aria-label="Page"
        inputMode="numeric"
        onFocus={() => {
          editingRef.current = true;
        }}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            editingRef.current = false;
            setDraft(String(page));
            event.currentTarget.blur();
          }
        }}
        style={{
          width: 46,
          height: 18,
          padding: '0 4px',
          textAlign: 'right',
          fontSize: 12,
          fontFamily: 'inherit',
          color: textColor,
          background: INPUT_BACKGROUND,
          border: `1px solid ${edgeColor}`,
          outline: 'none'
        }}
      />
      <span style={{ whiteSpace: 'pre' }}>{pageCount > 0 ? ` / ${pageCount}` : ''}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Find bar — `FindBar.cpp`
// ---------------------------------------------------------------------------

export interface LightPdfFindBarProps {
  theme: LightPdfThemeState;
  /** Anchor x inside the toolbar, measured from the Find button. */
  anchorLeft: number;
  matchCase: boolean;
  /** `CmdFindToggleMatchWholeWord` (434) — the strip's whole-word toggle. */
  wholeWord: boolean;
  status: string;
  query: string;
  /**
   * Which side of the toolbar the bar hangs on. `ToolbarPosition` can put the
   * toolbar at the bottom of the window, and light-pdf's find bar is a floating
   * window that is repositioned against it (`FindBarReposition`,
   * `Toolbar.cpp:853-855`), so the bar has to know which side that is.
   */
  placement?: 'below' | 'above';
  /** The toolbar's height, so the bar sits next to it rather than on it. */
  barHeight?: number;
  onQueryChange(query: string): void;
  onToggleMatchCase(): void;
  onToggleMatchWholeWord(): void;
  onFindNext(): void;
  onFindPrevious(): void;
  onClose(): void;
}

/**
 * `FindBar.cpp` — `FindBarWnd::Create` / `Layout`: a bordered popup holding the
 * edit (cue "Find"), an "n / m" status and the button strip. The strip's
 * "Open in a window" button is omitted because Eukolia's frozen PDF search
 * contract (`src/shared/ipc.ts`) exposes no floating results window — light-pdf
 * itself keeps it out of `LIGHTPDF_FIND_BAR_BUTTONS` for the same reason the
 * reference's `SearchUIFloating` is unimplemented.
 */
export const LightPdfFindBar: React.FC<LightPdfFindBarProps> = (props) => {
  const { theme } = props;
  const controlBg = themeControlBackgroundColor(theme);
  const edgeColor = bgrToHex(accentColor(controlBg, 40));
  const hotColor = bgrToHex(accentColor(controlBg, 20));
  const textColor = bgrToHex(themeWindowTextColor(theme));
  const linkColor = bgrToHex(themeWindowLinkColor(theme));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  /**
   * `FindBar.cpp` — the strip's buttons, `LIGHTPDF_FIND_BAR_BUTTONS` entry for
   * entry. The whole-word toggle is real: `CmdFindToggleMatchWholeWord` (434)
   * travels through the pane into the viewer's `find` options and on to the
   * engine's `SetMatchWholeWord` (`worker_main.cpp:1155`). The Close button
   * below carries `kFindBarCloseCmdId`.
   */
  const buttons = LIGHTPDF_FIND_BAR_BUTTONS.filter((button) => button.command !== FindBarCloseId);

  return (
    <div
      data-testid="pdf-find-bar"
      data-placement={props.placement ?? 'below'}
      style={{
        position: 'absolute',
        ...(props.placement === 'above'
          ? { bottom: props.barHeight ?? 26 }
          : { top: props.barHeight ?? 26 }),
        left: Math.max(4, props.anchorLeft),
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: 6,
        background: bgrToHex(controlBg),
        border: `1px solid ${edgeColor}`,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: 12,
        color: textColor
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose();
        else if (event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) props.onFindPrevious();
          else props.onFindNext();
        }
      }}
    >
      <input
        ref={inputRef}
        value={props.query}
        placeholder="Find"
        aria-label="Find"
        onChange={(event) => props.onQueryChange(event.target.value)}
        style={{
          width: 220,
          height: 20,
          padding: '0 4px',
          fontSize: 12,
          fontFamily: 'inherit',
          color: textColor,
          background: INPUT_BACKGROUND,
          border: `1px solid ${edgeColor}`,
          outline: 'none'
        }}
      />
      {/* `FindBar.cpp` — `statusDx = DpiScale(hwnd, 88)`; text is "n / m". */}
      <span style={{ width: 88, textAlign: 'center', color: textColor }}>{props.status}</span>
      {buttons.map((button) => (
        <ToolbarButton
          key={button.toolTip}
          command={button.command}
          title={typeof button.command === 'number' ? lightPdfToolTipWithAccelerator(button.command, button.toolTip) : button.toolTip}
          iconSvg={getSvgIcon(button.icon)}
          disabled={false}
          checked={
            (button.command === LIGHTPDF_CMD.CmdFindToggleMatchCase && props.matchCase) ||
            (button.command === LIGHTPDF_CMD.CmdFindToggleMatchWholeWord && props.wholeWord)
          }
          textColor={textColor}
          disabledColor={textColor}
          hotColor={hotColor}
          linkColor={linkColor}
          onClick={() => {
            if (button.command === LIGHTPDF_CMD.CmdFindNext) props.onFindNext();
            else if (button.command === LIGHTPDF_CMD.CmdFindPrev) props.onFindPrevious();
            else if (button.command === LIGHTPDF_CMD.CmdFindToggleMatchCase) props.onToggleMatchCase();
            else if (button.command === LIGHTPDF_CMD.CmdFindToggleMatchWholeWord) props.onToggleMatchWholeWord();
          }}
        />
      ))}
      <ToolbarButton
        title="Close"
        iconSvg={getSvgIcon(TbIcon.Close)}
        disabled={false}
        checked={false}
        textColor={textColor}
        disabledColor={textColor}
        hotColor={hotColor}
        linkColor={linkColor}
        onClick={props.onClose}
      />
    </div>
  );
};
