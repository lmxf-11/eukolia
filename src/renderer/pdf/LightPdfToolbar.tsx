/**
 * PDF controls reuse light-pdf's commands and icons in a compact floating panel.
 * Unsupported actions and redundant separators are omitted. Inputs follow the
 * selected viewer theme; keyboard focus and checked states remain visible.
 */

import './pdf-chrome.css';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, FolderOpen, LayoutPanelTop, Maximize2, RotateCcw, RotateCw, ZoomIn, ZoomOut, Search, CaseSensitive, WholeWord, X, type LucideIcon } from '../ui/components/icons';

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

/** Supported actions retain the reference's order and functional grouping. */
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
  const available = LIGHTPDF_TOOLBAR.filter(entry => entry.command === null ||
    (IMPLEMENTED_COMMANDS.has(entry.command) && (entry.command !== PageInfoId || props.pageInfoVisible !== false)));
  const entries = available.filter((entry, index) => entry.command !== null ||
    (index > 0 && index < available.length - 1 && available[index - 1].command !== null));

  /**
   * `ToolbarSize` sizes the icons, and the bar follows: light-pdf's rebar band is
   * the icon box plus its padding (`Toolbar.cpp:1402-1417`, where
   * `iconDy = RoundUp(DpiScale(iconSize), 4)`).
   */
  const iconSize = Math.max(8, Math.round(props.iconSize ?? LIGHTPDF_TOOLBAR_METRICS.defaultIconSize));
  const buttonSize = iconSize + 10;
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
      className="eu-pdf-toolbar"
      role="toolbar"
      aria-label="PDF controls"
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
        minHeight: barHeight,
        flexWrap: 'wrap',
        padding: '4px 6px',
        gap: LIGHTPDF_TOOLBAR_METRICS.buttonSpacingX,
        background: bgrToHex(controlBg),
        color: textColor,
        border: `1px solid ${edgeColor}`,
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
          return <div key={`sep-${index}`} aria-hidden="true" style={{ width: 1, flexShrink: 0, height: Math.round(iconSize * 0.9), background: edgeColor, margin: '0 2px' }} />;
        }
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
              background={bgrToHex(controlBg)}
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

const TOOLBAR_ICONS: Record<string, LucideIcon> = {
  [LIGHTPDF_CMD.CmdOpenFile]: FolderOpen,
  [LIGHTPDF_CMD.CmdGoToPrevPage]: ChevronLeft,
  [LIGHTPDF_CMD.CmdGoToNextPage]: ChevronRight,
  [LIGHTPDF_CMD.CmdNavigateBack]: ArrowLeft,
  [LIGHTPDF_CMD.CmdNavigateForward]: ArrowRight,
  [LIGHTPDF_CMD.CmdZoomFitWidthAndContinuous]: LayoutPanelTop,
  [LIGHTPDF_CMD.CmdZoomFitPageAndSinglePage]: Maximize2,
  [LIGHTPDF_CMD.CmdRotateLeft]: RotateCcw,
  [LIGHTPDF_CMD.CmdRotateRight]: RotateCw,
  [LIGHTPDF_CMD.CmdZoomOut]: ZoomOut,
  [LIGHTPDF_CMD.CmdZoomIn]: ZoomIn,
  [LIGHTPDF_CMD.CmdFindFirst]: Search,
  [LIGHTPDF_CMD.CmdFindPrev]: ChevronUp,
  [LIGHTPDF_CMD.CmdFindNext]: ChevronDown,
  [LIGHTPDF_CMD.CmdFindToggleMatchCase]: CaseSensitive,
  [LIGHTPDF_CMD.CmdFindToggleMatchWholeWord]: WholeWord,
  [FindBarCloseId]: X
};

const ToolbarButton: React.FC<{
  /** light-pdf's `idCommand`, exposed so the find bar can anchor under it. */
  command?: string | number;
  title?: string;
  iconSvg: string | null;
  disabled: boolean;
  checked: boolean;
  /** `ToolbarSize` — the icon box, in pixels. */
  iconSize?: number;
  /** The button box includes comfortable pointer padding. */
  buttonSize?: number;
  textColor: string;
  disabledColor: string;
  hotColor: string;
  linkColor: string;
  onClick(): void;
}> = ({ command, title, iconSvg, disabled, checked, iconSize = LIGHTPDF_TOOLBAR_METRICS.defaultIconSize, buttonSize = LIGHTPDF_TOOLBAR_METRICS.defaultIconSize + 10, textColor, disabledColor, hotColor, linkColor, onClick }) => {
  const [hover, setHover] = useState(false);
  const Icon = command === undefined ? undefined : TOOLBAR_ICONS[String(command)];
  const color = disabled ? disabledColor : checked ? linkColor : textColor;
  return (
    <button
      type="button"
      className="eu-pdf-tool-button"
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
        borderRadius: 6,
        background: checked || (hover && !disabled) ? hotColor : 'transparent',
        color,
        cursor: disabled ? 'default' : 'pointer',
        flexShrink: 0
      }}
    >
      {Icon ? <span style={{ display: 'block', width: iconSize, height: iconSize }}><Icon size={iconSize} strokeWidth={1.7} aria-hidden="true" /></span> : iconSvg && (
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
  background: string;
  onGoToPage(page: number): void;
}> = ({ page, pageCount, textColor, edgeColor, background, onGoToPage }) => {
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
      <span style={{ paddingRight: 2 }}>Page</span>
      <input
        className="eu-pdf-field"
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
          height: 26,
          padding: '0 4px',
          textAlign: 'right',
          fontSize: 12,
          fontFamily: 'inherit',
          color: textColor,
          background,
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
      className="eu-pdf-find-bar"
      role="search"
      aria-label="Find in PDF"
      data-testid="pdf-find-bar"
      data-placement={props.placement ?? 'below'}
      style={{
        position: 'absolute',
        ...(props.placement === 'above'
          ? { bottom: 'calc(100% + 6px)' }
          : { top: 'calc(100% + 6px)' }),
        right: 0,
        maxWidth: '100%',
        width: 'max-content',
        flexWrap: 'wrap',
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: 8,
        background: bgrToHex(controlBg),
        border: `1px solid ${edgeColor}`,
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)',
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
        className="eu-pdf-field"
        ref={inputRef}
        value={props.query}
        placeholder="Find"
        aria-label="Find"
        onChange={(event) => props.onQueryChange(event.target.value)}
        style={{
          width: 160,
          minWidth: 70,
          flex: '1 1 80px',
          height: 28,
          padding: '0 4px',
          fontSize: 12,
          fontFamily: 'inherit',
          color: textColor,
          background: bgrToHex(controlBg),
          border: `1px solid ${edgeColor}`,
          outline: 'none'
        }}
      />
      {/* `FindBar.cpp` — `statusDx = DpiScale(hwnd, 88)`; text is "n / m". */}
      <span style={{ minWidth: 32, textAlign: 'center', color: textColor }}>{props.status}</span>
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
        command={FindBarCloseId}
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
