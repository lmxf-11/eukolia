/**
 * TabBar — the open-document strip (Instructions.md §44, §67).
 *
 * ## The top strip of the window
 *
 * The window is frameless (`titleBarStyle: 'hidden'`, main.ts) and has no title
 * bar above this one, so this *is* the window's top edge. Three things follow,
 * and all three are this component's rather than a second component's:
 *
 *   • **it is the drag region.** The tab strip carries `-webkit-app-region: drag`
 *     and every tab and button inside it opts back out with `no-drag` (the tabs in
 *     `eukolia-shell.css`, the controls through `.eu-tab-bar__toolbar` and
 *     `.eu-window-button`). A double-click on the empty part of the strip
 *     maximises or restores the window, which is what a caption does on Windows.
 *   • **it carries the window controls.** Minimise, maximise/restore and close are
 *     drawn here (`eu-window-controls`) rather than by the platform: Windows only
 *     paints its own controls over a `titleBarOverlay` region at the top of the
 *     window, and the bar that used to reserve that region is gone.
 *   • **the whole row can be hidden.** `view.toggleTabBar` hides the tabs,
 *     toolbar, drag region and window controls together. The status-bar toggle
 *     or Ctrl+Alt+T restores the row.
 *
 * ## The document strip
 *
 * Handles dirty and externally-changed indicators, middle-click closing,
 * horizontal scrolling when the strip overflows (the wheel itself is the shell's,
 * `core/smoothScroll`), and HTML5 drag-and-drop reordering backed by
 * `workspaceService.reorderDocument`.
 *
 * Pinned tabs are still rendered first, but the pin control itself lives in the
 * `Ctrl+Tab` tab switcher: the strip only shows the state. Every tab, pinned or
 * not, keeps its close button visible at all times — closing a tab with unsaved
 * changes is confirmed first, and that confirmation is what protects a pinned
 * tab. The pinned block is a real region — a drag can never move an unpinned tab
 * in front of a pinned one (or vice versa), because that would break the
 * "pinned tabs come first" invariant the service maintains.
 *
 * ## The toolbar on its right-hand end
 *
 * When visible, the strip sits directly above the document, so the controls
 * for *getting the document built
 * and read* live on its right-hand end rather than in a toolbar of their own —
 * `Instructions.md` §55 rules out "permanent toolbars full of rarely used
 * actions", and these are not rare.
 *
 * Four actions and three controls, because two of them are pairs:
 *
 * | Control | Primary press | Menu |
 * | --- | --- | --- |
 * | Compile | `latex.build` (`Ctrl+B`) | show/hide the viewer, Build and View, build with a recipe, stop |
 * | Code / Visual | `editor.toggleMode` (`Ctrl+Shift+V`) | Code Mode (`Ctrl+1`), Visual Mode (`Ctrl+2`) |
 * | Focus Mode | `view.toggleFocusMode` (`Ctrl+Alt+1`) | — |
 *
 * **Every one of them is a command**, so the palette, the sidebar's Menu view,
 * the shortcut editor and this toolbar are one implementation with four ways in
 * (§46) — and none of them holds state of its own. Pressed or not, enabled or not,
 * the button reads app state that the command itself wrote, which is what keeps the
 * control and the keyboard from disagreeing; the same rule `ui/components/
 * StatusBar.tsx` follows for its own layout cluster.
 *
 * **The shortcuts in the tooltips are read, never written.** Each title is built
 * from `commandRegistry.getKeybinding`, so rebinding a command in Settings →
 * Keyboard changes what the control claims in the same breath — a hard-coded
 * `(Ctrl+B)` would go on naming a key the application no longer answers to — and
 * only while the command really owns the binding, since two commands can share
 * one key and only the first resolves. `tests/ui/tab-bar-toolbar.render.test.ts`
 * and `tests/ui/tab-bar-toolbar-commands.test.ts` assert both halves.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state';
import { workspaceService } from '../../services/instance';
import type { OpenDocument } from '../../services/workspace';
import { commandRegistry, translateKeybinding } from '../../core/commands';
import { TopLeftMenuButton } from './TopLeftMenuButton';
import { sidebarChromeVisible } from '../sidebarRegion';
import { setting, settingsManager } from '../../core/settings';
import {
  BookMarked,
  ChevronDown,
  CircleAlert,
  Code,
  Code2,
  Eye,
  EyeOff,
  FileArchive,
  FileBox,
  FileClock,
  FileCode,
  FileCode2,
  FileJson,
  FileSliders,
  FileSpreadsheet,
  FileText,
  Focus,
  Globe,
  Image,
  Layers,
  Library,
  LoaderCircle,
  Palette,
  Pin,
  Play,
  Plus,
  Square,
  Terminal,
  Type,
  X,
  ZoomIn
} from './icons';
import { WindowControlIcon } from './WindowControlIcon';

export interface TabBarProps {
  /** Whether the panel bar is on screen. When false, the compact expandable Menu button is shown on the top left. */
  panelBarShown?: boolean;
}

/** Clamps a drop index so a drag cannot break the pinned-first invariant. */
export function clampDropIndex(target: number, fromIndex: number, pinnedCount: number, total: number): number {
  if (total <= 0) return 0;
  // Moving right shortens the array by one before the insertion happens.
  const adjusted = fromIndex !== -1 && fromIndex < target ? target - 1 : target;
  if (fromIndex === -1) return Math.max(0, Math.min(adjusted, total - 1));

  const isPinned = fromIndex < pinnedCount;
  const lower = isPinned ? 0 : Math.min(pinnedCount, total - 1);
  const upper = isPinned ? Math.max(0, pinnedCount - 1) : total - 1;
  return Math.max(lower, Math.min(adjusted, Math.max(lower, upper)));
}

/** A tab's display name, with the file extension removed. */
export function formatTabLabel(filename: string): string {
  const name = filename.replace(/^.*[\\/]/, '');
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0) {
    return name.slice(0, lastDot);
  }
  return name;
}

/** A dedicated vector icon for LaTeX / TeX files, featuring a document with classic TeX monogram. */
export const TexFileIcon: React.FC<{ size?: number; color?: string; style?: React.CSSProperties }> = ({
  size = 13,
  color = '#10b981',
  style
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ flexShrink: 0, ...style }}
  >
    <path
      d="M3 2C3 1.44772 3.44772 1 4 1H10L14 5V14C14 14.5523 13.5523 15 13 15H4C3.44772 15 3 14.5523 3 14V2Z"
      stroke={color}
      strokeWidth="1.4"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.12"
    />
    <path d="M10 1V5H14" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 7.8H7.6M6.3 7.8V12" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    <path d="M9.4 9H8V12H9.4M8 10.5H9.1" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10.4 9.4L12.4 12M12.4 9.4L10.4 12" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

/** Renders a vivid, distinct file type icon to visually distinguish different files in the tab bar. */
export function renderTabIcon(filename: string): React.ReactNode {
  // LaTeX documents (.tex, .ltx) -> dedicated TeX icon in emerald
  if (/\.(tex|ltx)$/i.test(filename)) {
    return <TexFileIcon size={13} color="#10b981" />;
  }
  // LaTeX style / package files (.sty) -> FileBox in royal indigo
  if (/\.sty$/i.test(filename)) {
    return <FileBox size={13} strokeWidth={2} style={{ color: '#6366f1', flexShrink: 0 }} />;
  }
  // LaTeX document class files (.cls) -> Layers in vivid violet
  if (/\.cls$/i.test(filename)) {
    return <Layers size={13} strokeWidth={2} style={{ color: '#a855f7', flexShrink: 0 }} />;
  }
  // BibTeX bibliographies (.bib) -> BookMarked in rich amber/gold
  if (/\.bib$/i.test(filename)) {
    return <BookMarked size={13} strokeWidth={2} style={{ color: '#f59e0b', flexShrink: 0 }} />;
  }
  // TikZ graphics & drawings (.tikz) -> Palette in jade green
  if (/\.tikz$/i.test(filename)) {
    return <Palette size={13} strokeWidth={2} style={{ color: '#059669', flexShrink: 0 }} />;
  }
  // DocTeX & installers (.dtx, .ins) -> FileArchive in deep teal
  if (/\.(dtx|ins)$/i.test(filename)) {
    return <FileArchive size={13} strokeWidth={2} style={{ color: '#0d9488', flexShrink: 0 }} />;
  }
  // PDF documents (.pdf) -> FileText in Adobe crimson red
  if (/\.pdf$/i.test(filename)) {
    return <FileText size={13} strokeWidth={2} style={{ color: '#ef4444', flexShrink: 0 }} />;
  }
  // Markdown notes (.md, .markdown) -> FileText in vivid sky blue
  if (/\.(md|markdown|mdown|mkdn)$/i.test(filename)) {
    return <FileText size={13} strokeWidth={2} style={{ color: '#0284c7', flexShrink: 0 }} />;
  }
  // JSON data (.json, .jsonc) -> FileJson in bright orange
  if (/\.jsonc?$/i.test(filename)) {
    return <FileJson size={13} strokeWidth={2} style={{ color: '#f59e0b', flexShrink: 0 }} />;
  }
  // TypeScript (.ts, .tsx) -> FileCode in TypeScript blue
  if (/\.tsx?$/i.test(filename)) {
    return <FileCode size={13} strokeWidth={2} style={{ color: '#3b82f6', flexShrink: 0 }} />;
  }
  // JavaScript (.js, .mjs, .cjs) -> FileCode2 in JavaScript yellow
  if (/\.(m?js|cjs)$/i.test(filename)) {
    return <FileCode2 size={13} strokeWidth={2} style={{ color: '#eab308', flexShrink: 0 }} />;
  }
  // React JSX (.jsx) -> Code2 in React cyan
  if (/\.jsx$/i.test(filename)) {
    return <Code2 size={13} strokeWidth={2} style={{ color: '#06b6d4', flexShrink: 0 }} />;
  }
  // CSS / SCSS / LESS (.css, .scss, .sass, .less) -> Palette in fuchsia pink
  if (/\.(css|scss|sass|less)$/i.test(filename)) {
    return <Palette size={13} strokeWidth={2} style={{ color: '#ec4899', flexShrink: 0 }} />;
  }
  // HTML (.html, .htm) -> Globe in HTML5 orange
  if (/\.html?$/i.test(filename)) {
    return <Globe size={13} strokeWidth={2} style={{ color: '#f97316', flexShrink: 0 }} />;
  }
  // Image assets (.png, .jpg, .jpeg, .svg, .gif, .webp, .ico) -> Image in emerald green
  if (/\.(png|jpe?g|svg|gif|webp|ico)$/i.test(filename)) {
    return <Image size={13} strokeWidth={2} style={{ color: '#22c55e', flexShrink: 0 }} />;
  }
  // Python (.py) -> FileCode2 in Python blue
  if (/\.py$/i.test(filename)) {
    return <FileCode2 size={13} strokeWidth={2} style={{ color: '#3b82f6', flexShrink: 0 }} />;
  }
  // Shell scripts (.sh, .bash, .zsh, .ps1, .bat, .cmd) -> Terminal in terminal lime
  if (/\.(sh|bash|zsh|ps1|bat|cmd)$/i.test(filename)) {
    return <Terminal size={13} strokeWidth={2} style={{ color: '#10b981', flexShrink: 0 }} />;
  }
  // Config files (.yaml, .yml, .toml, .ini, .env, .cfg) -> FileSliders in violet
  if (/\.(ya?ml|toml|ini|env|cfg)$/i.test(filename)) {
    return <FileSliders size={13} strokeWidth={2} style={{ color: '#8b5cf6', flexShrink: 0 }} />;
  }
  // Data tables (.csv, .tsv) -> FileSpreadsheet in forest green
  if (/\.(csv|tsv)$/i.test(filename)) {
    return <FileSpreadsheet size={13} strokeWidth={2} style={{ color: '#059669', flexShrink: 0 }} />;
  }
  // LaTeX build/auxiliary files -> FileClock in muted slate
  if (/\.(log|aux|bbl|blg|out|toc|synctex\.gz|fls|fdb_latexmk)$/i.test(filename)) {
    return <FileClock size={13} strokeWidth={2} style={{ color: '#64748b', flexShrink: 0 }} />;
  }
  // Default fallback -> FileText in soft muted silver
  return <FileText size={13} strokeWidth={1.8} style={{ color: '#94a3b8', flexShrink: 0 }} />;
}

/* ------------------------------------------------------------------ shortcuts */

/**
 * The command's shortcut, but only while it is really the command's own.
 *
 * Read through the registry rather than from the command's registered default:
 * a shortcut rebound in Settings, or switched off by writing an empty string,
 * changes what this returns on the next render — which is the whole point of
 * building a tooltip out of it.
 *
 * Two commands can share a key, though, and only the first one registered answers
 * to it — `Ctrl+B` is both "toggle the side bar" and "build the project", and the
 * side bar wins it. A tooltip that went on stating `Ctrl+B` for Compile would be
 * describing a key that does something else, so the clause is left out and the
 * press is described by the button and the menu instead. That is what
 * `getBindingOwner` answers, and it is why this asks the registry rather than
 * carrying a table: a shortcut the user rebinds *onto* this command is its own by
 * construction.
 */
export function ownedShortcutFor(commandId: string): string {
  const binding = commandRegistry.getKeybinding(commandId);
  if (!binding) return '';
  if (commandRegistry.getBindingOwner(binding) !== commandId) return '';
  return translateKeybinding(binding);
}

/** A tooltip sentence with the command's current shortcut appended. */
export function shortcutTitle(text: string, commandId: string): string {
  const shortcut = ownedShortcutFor(commandId);
  return shortcut ? `${text} (${shortcut})` : text;
}

/** A tooltip for a control whose label states what the press will do. */
export function toggleTitle(what: string, active: boolean, commandId: string): string {
  return shortcutTitle(`${active ? 'Hide' : 'Show'} ${what}`, commandId);
}

/* -------------------------------------------------------------- menu contents */

export type TabBarMenu = 'none' | 'pdf';

export interface ToolbarMenuItem {
  /** The command this entry dispatches, and which supplies its shortcut. */
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Drawn as `aria-checked` — for exclusive menu entries. */
  checked?: boolean;
}

/**
 * The PDF control's menu.
 *
 * Three entries, and the first is what makes the control's own state legible: the
 * viewer has a button of its own in the strip, but a menu opened from the control
 * that *builds* the PDF is where a reader looks for "and show it to me". It says
 * which way it will go, because the control reports the viewer's state and the
 * menu must not contradict it.
 *
 * Rebuild is deliberately not here. It is a command with a binding and an entry
 * in the Run menu; the menu belongs to the three actions that decide *what* is
 * shown after a build, and §3.8 names exactly these three.
 */
export function pdfMenuItems(clientVisible = true): ToolbarMenuItem[] {
  return [
    {
      id: 'pdf.toggleViewer',
      label: clientVisible ? 'Hide the PDF Viewer' : 'Show the PDF Viewer',
      icon: clientVisible ? <EyeOff size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />
    },
    { id: 'latex.buildAndView', label: 'Build and View', icon: <Eye size={13} strokeWidth={2} /> },
    { id: 'latex.buildWithRecipe', label: 'Build with Recipe…', icon: <Play size={13} strokeWidth={2} /> }
  ];
}

/** The two modes, as the exclusive pair they are. */
export function modeMenuItems(editorMode: 'code' | 'visual'): ToolbarMenuItem[] {
  return [
    { id: 'editor.codeMode', label: 'Code Mode', icon: <Code size={13} strokeWidth={2} />, checked: editorMode === 'code' },
    { id: 'editor.visualMode', label: 'Visual Mode', icon: <Type size={13} strokeWidth={2} />, checked: editorMode === 'visual' }
  ];
}

/** A button that closes its own popover on an outside click or Escape. */
function useDismissable(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      // The target is a `Node` for a click on the document and the *window*
      // itself for one that reaches no element — a click on the scrollbar, or a
      // programmatic dispatch — and `contains` throws on anything that is not a
      // node rather than answering false, which would take the window down.
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

export const TabBar: React.FC<TabBarProps> = ({ panelBarShown: panelBarShownProp }) => {

  const {
    documents,
    activeDocument,
    setActiveDocument,
    closeDocument,
    newFile,
    build,
    pdf,
    editorMode,
    layout,
    tabBarVisible,
    sidebarVisible,
    activityBarVisible
  } = useAppState();

  const [settingsRevision, setSettingsRevision] = useState(0);
  useEffect(() => settingsManager.on('change', () => setSettingsRevision((value) => value + 1)), []);
  const collapseWithSidebar = useMemo(
    () => setting.bool('appearance.collapseActivityBarWithSidebar'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsRevision]
  );
  const isPanelBarShown =
    panelBarShownProp !== undefined
      ? panelBarShownProp
      : sidebarChromeVisible({
          sidebarRequested: sidebarVisible,
          activityBarEnabled: activityBarVisible,
          collapseWithSidebar
        });

  const [dragUri, setDragUri] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [hoveredTabUri, setHoveredTabUri] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<TabBarMenu>('none');
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  const pinnedCount = useMemo(() => documents.filter((entry) => entry.pinned).length, [documents]);
  const activeUri = activeDocument?.doc.uri ?? null;
  const activeIndex = useMemo(() => documents.findIndex((entry) => entry.doc.uri === activeUri), [documents, activeUri]);

  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!window.eukoliaApi?.isWindowMaximized) return;
    void window.eukoliaApi.isWindowMaximized().then(setMaximized).catch(() => undefined);
    return window.eukoliaApi.onWindowMaximizedChanged?.(setMaximized);
  }, []);

  const barHeight = maximized ? TAB_BAR_MAXIMIZED_HEIGHT : TAB_BAR_HEIGHT;

  // ------------------------------------------------------------ window controls

  /**
   * The three caption buttons, drawn here because nothing else draws them.
   *
   * The window is frameless and the platform's overlay is not configured for it —
   * Windows only paints its own controls over a `titleBarOverlay` region at the
   * very top of the window, and this bar exists to *be* the top of the window, so
   * there is no second row to put one in. Each press is one IPC call and nothing
   * else: the button holds no state, and `maximized` is the window's own answer,
   * pushed on every change, so the middle glyph names the move it will make
   * rather than the state it is in.
   */
  const minimizeWindow = useCallback(() => {
    void window.eukoliaApi?.minimizeWindow?.();
  }, []);

  const toggleMaximizeWindow = useCallback(() => {
    void window.eukoliaApi?.toggleMaximizeWindow?.().then(setMaximized).catch(() => undefined);
  }, []);

  const closeWindow = useCallback(() => {
    void window.eukoliaApi?.closeWindow?.();
  }, []);

  /**
   * A double-click on the drag region maximises, as a caption does.
   *
   * The OS cannot do it for this bar — `-webkit-app-region: drag` moves the
   * window but does not implement the platform's own double-click gesture — so the
   * tab strip answers it directly. Bound on the strip rather than on the bar: the
   * toolbar is where a double-click means "press twice", and swallowing it there
   * would make Compile fire twice.
   */
  const onStripDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      toggleMaximizeWindow();
    },
    [toggleMaximizeWindow]
  );

  /**
   * The surface the document itself is drawn on.
   *
   * Code Mode and Visual Mode paint different backgrounds — the ported Overleaf
   * theme is the first's, the manuscript page the second's — and the whole join
   * depends on the strip agreeing with whichever is showing. It is read here
   * rather than in the stylesheet for the same reason the tab's own background
   * is inline: this is the one value in the tab bar that is not a choice about
   * the tab bar.
   */
  const editorSurface = editorMode === 'visual' ? 'var(--eu-visual-bg, var(--eu-editor-bg))' : 'var(--eu-editor-bg)';

  // Leave room above the rounded tops while all tabs share the editor baseline.
  const tabHeight = barHeight - 4;

  /**
   * The shortcut editor and the Settings UI can rebind a command while this bar
   * is on screen, and every tooltip here states a binding. The registry emits
   * `keybindings-changed` for both, so the bar re-renders and the titles follow
   * — without this the tooltip would keep naming the previous key until
   * something else happened to re-render the strip.
   *
   * The counter is not read anywhere; it is the re-render. `void bindingRevision`
   * in the render body is what says so out loud, rather than leaving a state
   * value that looks unused.
   */
  const [bindingRevision, setBindingRevision] = useState(0);
  useEffect(() => commandRegistry.on('keybindings-changed', () => setBindingRevision((value) => value + 1)), []);
  void bindingRevision;

  // The strip's wheel is the shell's (`core/smoothScroll`): it scrolls on one axis
  // only, so a plain notch moves it sideways with the same easing as every other
  // list, and the glide it does for the active tab stays `scroll-behavior`'s.
  useEffect(() => {
    if (typeof activeTabRef.current?.scrollIntoView === 'function') {
      activeTabRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeUri, documents.length]);

  const finishDrag = useCallback(() => {
    setDragUri(null);
    setDropIndex(null);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!dragUri || dropIndex === null) {
        finishDrag();
        return;
      }
      const fromIndex = documents.findIndex((entry) => entry.doc.uri === dragUri);
      workspaceService.reorderDocument(dragUri, clampDropIndex(dropIndex, fromIndex, pinnedCount, documents.length));
      finishDrag();
    },
    [documents, dragUri, dropIndex, finishDrag, pinnedCount]
  );

  // ------------------------------------------------------------- toolbar actions

  /**
   * The commands the toolbar dispatches, all through the registry.
   *
   * `execute` is what the palette and the menus call, so a button on this strip
   * cannot behave differently from the menu entry that names the same command —
   * including its `when` clause, which is why `latex.stopBuild` simply does
   * nothing when no build is running rather than the button having to guess.
   */
  const run = useCallback((id: string) => {
    setOpenMenu('none');
    void commandRegistry.execute(id);
  }, []);

  const closeMenu = useCallback(() => setOpenMenu('none'), []);
  const menuRef = useDismissable(openMenu !== 'none', closeMenu);

  const building = build.status === 'running';
  const failed = build.status === 'failed';
  const viewerVisible = pdf.visible;
  // Focus Mode is a *layout*, so the control reads it rather than holding a
  // toggle of its own: the same value the View menu and `Ctrl+Alt+1` write.
  const focusMode = layout === 'editor';
  /**
   * One tab.
   *
   * A callback rather than a nested component: a component declared inside this
   * one is a *new type* on every render, so React would unmount and remount every
   * tab each time the strip drew — which throws away the scroll position of the
   * active tab and turns every keystroke in the editor into a strip-wide remount.
   */
  const renderTab = useCallback(
    (entry: OpenDocument, index: number) => {
      const uri = entry.doc.uri;
      const dirty = entry.doc.getDirty();
      const isActive = uri === activeUri;
      const isHovered = hoveredTabUri === uri;
      const showCloseButton = isActive || isHovered;
      const before = dropIndex === index;
      const after = dropIndex === index + 1 && index === documents.length - 1;
      const isBeforeActive = activeIndex !== -1 && index === activeIndex - 1;
      const isAfterActive = activeIndex !== -1 && index === activeIndex + 1;

      const state = dirty ? 'unsaved changes' : 'saved';
      const external = entry.externalChange ? ' · changed on disk' : '';
      const recovered = entry.recovered ? ' · recovered buffer' : '';
      const activeBg = editorSurface;

      return (
        <div
          key={uri}
          ref={isActive ? activeTabRef : undefined}
          role="tab"
          aria-selected={isActive}
          tabIndex={0}
          draggable
          title={`${uri}\n${entry.doc.filename} — ${state}${external}${recovered}\nDrag to reorder · middle-click to close · Ctrl+Tab to pin or switch`}
          onClick={() => setActiveDocument(uri)}
          onMouseEnter={() => setHoveredTabUri(uri)}
          onMouseLeave={() => setHoveredTabUri((current) => (current === uri ? null : current))}
          onPointerEnter={() => setHoveredTabUri(uri)}
          onPointerLeave={() => setHoveredTabUri((current) => (current === uri ? null : current))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setActiveDocument(uri);
            } else if (event.key === 'Delete') {
              // Pinning no longer protects a tab from being closed — the close
              // button is shown on every tab, pinned or not — so `Delete` must not
              // be the one gesture that silently ignores a pinned tab. It is a
              // *placement* guarantee (pinned tabs sort first), not a lock.
              event.preventDefault();
              void closeDocument(uri);
            }
          }}
          onAuxClick={(event) => {
            // Middle-click closes, matching every editor users already know.
            if (event.button === 1) {
              event.preventDefault();
              void closeDocument(uri);
            }
          }}
          onDragStart={(event) => {
            setDragUri(uri);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', uri);
          }}
          onDragOver={(event) => {
            if (!dragUri) return;
            event.preventDefault();
            // Keep the precise index: the strip's own handler would otherwise
            // overwrite it with "append at the end" as the event bubbles.
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            const rect = event.currentTarget.getBoundingClientRect();
            setDropIndex(event.clientX > rect.left + rect.width / 2 ? index + 1 : index);
          }}
          onDrop={(event) => {
            event.stopPropagation();
            onDrop(event);
          }}
          onDragEnd={finishDrag}
          className="eu-tab"
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
            // One height for every tab, selected or not: see `tabHeight`. A tab
            // that changed size on selection would move its neighbours and sit on
            // a different baseline from the tab it replaced, which is what made
            // switching tabs look like a re-layout rather than a change of focus.
            height: tabHeight,
            maxWidth: 220,
            minWidth: 96,
            padding: '0 6px 0 10px',
            color: isActive ? 'var(--eu-fg-primary)' : (isHovered ? 'var(--eu-fg-primary)' : 'var(--eu-fg-secondary)'),
            // Every tab is set at the same weight. A selected tab used to go to
            // 500, which reads as *bold* at 12px and makes the title jump
            // sideways as the selection moves — the same defect the shared height
            // removes from the row. What says which tab is selected is its colour
            // and its surface, and neither of those moves anything.
            fontWeight: 400,
            opacity: isActive ? 1 : (isHovered ? 1 : 0.78),
            background: isActive ? activeBg : 'transparent',
            borderTopLeftRadius: TAB_CORNER_RADIUS,
            borderTopRightRadius: TAB_CORNER_RADIUS,
            // The open bottom joins the editor; CSS draws the outward curves.
            borderBottomRightRadius: isActive ? 0 : isBeforeActive ? 6 : (isHovered ? 4 : 0),
            borderBottomLeftRadius: isActive ? 0 : isAfterActive ? 6 : (isHovered ? 4 : 0),
            borderTop: isActive ? '1px solid var(--eu-border)' : '1px solid transparent',
            borderLeft: isActive ? '1px solid var(--eu-border)' : '1px solid transparent',
            borderRight: isActive ? '1px solid var(--eu-border)' : '1px solid transparent',
            borderBottom: 'none',
            // No vertical offset either, for the same reason there is one height:
            // a tab nudged up by two pixels when it is not selected is a tab that
            // jumps down when it is, and the row would visibly re-settle on every
            // switch. All of that is gone; only the colour differs now.
            marginBottom: 0,
            zIndex: isActive ? 5 : 1,
            boxShadow: isActive
              ? // The strip's last pixel covers a hairline rule separating the
                // bar from the editor. Under a *selected* tab that rule must not
                // be there — the tab and the document are one surface — so the
                // tab paints that pixel with its own colour. It is a shadow
                // rather than a taller tab because the height is shared with
                // every other tab and must not change.
                `0 1px 0 0 ${activeBg}`
              : before
                ? 'inset 2px 0 0 var(--eu-accent)'
                : after
                  ? 'inset -2px 0 0 var(--eu-accent)'
                  : undefined
          } as React.CSSProperties}
        >
          {/*
            Pinning is managed in the `Ctrl+Tab` tab switcher, so the strip shows
            the pinned state rather than offering the control: the glyph is what
            explains why this tab sorts first.
          */}
          {entry.pinned && (
            <span title="Pinned — unpin it from the tab switcher (Ctrl+Tab)" className="eu-tab__pin" data-testid="tab-pinned-indicator">
              <Pin size={11} strokeWidth={2} />
            </span>
          )}

          {renderTabIcon(entry.doc.filename)}
          <span className="eu-tab__label">
            {formatTabLabel(entry.doc.filename)}
          </span>

          {entry.externalChange && (
            <span title="This file changed on disk" aria-hidden="true" className="eu-tab__state-dot eu-tab__state-dot--external" />
          )}
          {dirty && (
            <span title="Unsaved changes" aria-hidden="true" className="eu-tab__state-dot eu-tab__state-dot--dirty" />
          )}

          <button
            type="button"
            title={dirty ? 'Close (unsaved changes will be confirmed)' : 'Close'}
            aria-label={`Close ${entry.doc.filename}`}
            className="eu-tab__close"
            onClick={(event) => {
              event.stopPropagation();
              void closeDocument(uri);
            }}
            style={{
              opacity: showCloseButton ? 1 : 0,
              pointerEvents: showCloseButton ? 'auto' : 'none'
            }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      );
    },
    [
      activeIndex,
      activeUri,
      closeDocument,
      documents.length,
      dragUri,
      dropIndex,
      editorSurface,
      finishDrag,
      hoveredTabUri,
      onDrop,
      setActiveDocument,
      tabHeight
    ]
  );

  if (!tabBarVisible) return null;

  return (
    <div
      className="eu-tab-bar"
      style={{ ...bar, height: barHeight, ['--eu-tab-surface' as string]: editorSurface } as React.CSSProperties}
      data-testid="tab-bar"
    >
      {!isPanelBarShown && (
        <div style={topLeftButtonWrapper}>
          <TopLeftMenuButton />
        </div>
      )}
      {/*
        The document strip. It is also the window's drag region, so a press on the
        empty part of it — past the last tab — moves the window and a double-click
        there maximises it, which is what a caption does.
      */}
        <div
          role="tablist"
          aria-label="Open documents"
          className="eu-tab-strip"
          onDragOver={(event) => {
            if (!dragUri) return;
            event.preventDefault();
            setDropIndex(documents.length);
          }}
          onDrop={onDrop}
          onDoubleClick={onStripDoubleClick}
          style={strip}
        >
          {documents.map((entry: OpenDocument, index: number) => renderTab(entry, index))}

          {documents.length > 0 && (
            <div
              data-testid="tab-bar-separator"
              aria-hidden="true"
              className="eu-tab-bar__separator"
              style={{
                width: 1,
                flexShrink: 0,
                height: maximized ? 14 : 16,
                marginBottom: maximized ? 7 : 8,
                marginLeft: 4,
                marginRight: 2
              }}
            />
          )}

          <button
            type="button"
            data-testid="tab-bar-new-file"
            title={shortcutTitle('New LaTeX file', 'file.newFile')}
            aria-label="New file"
            className="eu-tab-bar__new"
            onClick={() => newFile()}
            style={{
              width: maximized ? 24 : 26,
              height: maximized ? 24 : 26,
              marginBottom: maximized ? 2 : 3
            }}
          >
            <Plus size={maximized ? 13 : 14} strokeWidth={2} />
          </button>
          {documents.length === 0 && (
            <div className="eu-tab-bar__empty">No open documents</div>
          )}
        </div>

      {/*
        The toolbar. Drawn after the strip so it is the last thing the flex row
        lays out — the tabs take the room that is left and scroll under it, and
        the controls are never pushed off the edge by a long file name.
      */}
      <div className="eu-tab-bar__toolbar" data-testid="tab-bar-toolbar" ref={menuRef}>
        {/* ---------------------------------------------- compile and viewer */}
        <div className="eu-tab-bar__split">
          <button
            type="button"
            data-testid="toolbar-compile"
            aria-label={building ? 'Compilation in progress' : 'Compile PDF'}
            title={
              building
                ? 'Compiling… the stop button cancels it'
                : failed
                  ? `Compile again — the last build failed\nOpen the Problems panel for the errors${shortcutText('latex.build', '\n')}`
                  : `Compile the project to PDF${shortcutText('latex.build', '\n')}`
            }
            aria-busy={building}
            onClick={() => run('latex.build')}
            className={`eu-tab-bar__button eu-tab-bar__button--main eu-tab-bar__compile${building ? ' eu-tab-bar__compile--busy' : ''}`}
            style={{ color: building ? 'var(--eu-info, #3b82f6)' : 'var(--eu-success, #10b981)' }}
          >
            {building ? (
              <LoaderCircle size={13} strokeWidth={2} className="eu-spin" />
            ) : (
              <Play size={13} strokeWidth={2} />
            )}
          </button>

          {/* The same press when a build is running stops it, which is what the
              button would be for; the entry stays in the menu as well so the
              control is discoverable rather than appearing only mid-build. */}
          {building && (
            <button
              type="button"
              data-testid="toolbar-stop-build"
              aria-label="Stop compilation"
              title={`Stop the running compilation${shortcutText('latex.stopBuild', '\n')}`}
              onClick={() => run('latex.stopBuild')}
              className="eu-tab-bar__button eu-tab-bar__button--chevron eu-tab-bar__stop"
            >
              <Square size={11} strokeWidth={2.4} />
            </button>
          )}

          <button
            type="button"
            data-testid="toolbar-pdf-menu"
            aria-label="PDF viewer controls"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'pdf'}
            title={'PDF viewer controls\nBuild and view it, or pick a recipe'}
            onClick={() => setOpenMenu((current) => (current === 'pdf' ? 'none' : 'pdf'))}
            className="eu-tab-bar__button eu-tab-bar__button--chevron"
            style={{ color: 'var(--eu-fg-muted)' }}
          >
            <ChevronDown size={12} strokeWidth={2} />
          </button>
        </div>

        {openMenu === 'pdf' && (
          <ToolbarDropdown
            testId="toolbar-pdf-menu-panel"
            items={pdfMenuItems(viewerVisible)}
            onRun={run}
            footer={<PdfStatusLine pdf={pdf} />}
          />
        )}

        {/* --------------------------- separator between pdf controls and editor mode */}
        <div
          data-testid="toolbar-build-mode-separator"
          aria-hidden="true"
          style={{
            width: 1,
            height: '100%',
            background: 'var(--eu-border)',
            margin: '0 4px',
            flexShrink: 0
          }}
        />

        {/* ------------------------------------------------------ editor mode */}
        <div className="eu-tab-bar__mode" data-testid="toolbar-mode" title={shortcutTitle('Switch between Code and Visual Mode', 'editor.toggleMode')}>
          <button
            type="button"
            data-testid="toolbar-mode-code"
            aria-label="Code mode"
            aria-pressed={editorMode === 'code'}
            title={shortcutTitle('Edit the LaTeX source (Code Mode)', 'editor.codeMode')}
            onClick={() => run('editor.codeMode')}
            className="eu-tab-bar__segment"
          >
            <Code size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            data-testid="toolbar-mode-visual"
            aria-label="Visual mode"
            aria-pressed={editorMode === 'visual'}
            title={shortcutTitle('Edit with rendered mathematics and structure (Visual Mode)', 'editor.visualMode')}
            onClick={() => run('editor.visualMode')}
            className="eu-tab-bar__segment"
          >
            <Type size={13} strokeWidth={2} />
          </button>
        </div>

        {/* -------------------------------------------------------- pdf viewer toggle */}
        <button
          type="button"
          data-testid="toolbar-toggle-pdf"
          aria-label={viewerVisible ? 'Hide the PDF viewer' : 'Show the PDF viewer'}
          aria-pressed={viewerVisible}
          title={toggleTitle('the PDF viewer', viewerVisible, 'pdf.toggleViewer')}
          onClick={() => run('pdf.toggleViewer')}
          className="eu-icon-btn eu-tab-bar__button"
        >
          <ZoomIn size={13} strokeWidth={2} />
        </button>

        {/* ---------------------------------------------------------- focus mode */}
        {/*
          Focus Mode's control, read from the layout the command writes rather
          than kept here: `view.focusMode` is one command that toggles, so the
          button and `Ctrl+Alt+1` cannot report different states.
        */}
        <button
          type="button"
          data-testid="toolbar-focus-mode"
          aria-label={focusMode ? 'Leave Focus Mode' : 'Enter Focus Mode'}
          aria-pressed={focusMode}
          title={shortcutTitle(`${focusMode ? 'Leave' : 'Enter'} Focus Mode`, 'view.focusMode')}
          onClick={() => run('view.focusMode')}
          className="eu-icon-btn eu-tab-bar__button"
        >
          <Focus size={13} strokeWidth={2} />
        </button>
      </div>

      {/*
        The window controls, at the window's own right-hand corner.

        They sit *outside* `.eu-tab-bar__toolbar` rather than inside it for one
        reason: the toolbar is a padded cluster of app controls that has opted out
        of the drag region, and these are the caption's — flush to the edge, as
        tall as the bar, and drawn only where the platform is not drawing them for
        it (`hasNativeWindowControls`, which is what tells a macOS window, whose
        traffic lights are the system's and sit on the left, from a frameless
        Windows one).

        `.eu-window-button` is the shell's existing caption-button treatment,
        shared with the auxiliary windows' own bars (`StandaloneTitleBar`), so the
        red close hover is one decision rather than three.
      */}
      {!window.eukoliaApi?.hasNativeWindowControls && (
        <div className="eu-window-controls eu-tab-bar__window-controls" data-testid="tab-bar-window-controls">
          <button
            type="button"
            data-testid="window-control-minimize"
            title="Minimise"
            aria-label="Minimise"
            className="eu-window-button"
            onClick={minimizeWindow}
          >
            <WindowControlIcon action="minimize" />
          </button>
          <button
            type="button"
            data-testid="window-control-maximize"
            title={maximized ? 'Restore' : 'Maximise'}
            aria-label={maximized ? 'Restore' : 'Maximise'}
            className="eu-window-button"
            onClick={toggleMaximizeWindow}
          >
            <WindowControlIcon action={maximized ? 'restore' : 'maximize'} />
          </button>
          <button
            type="button"
            data-testid="window-control-close"
            title="Close"
            aria-label="Close"
            className="eu-window-button eu-window-button--close"
            onClick={closeWindow}
          >
            <WindowControlIcon action="close" />
          </button>
        </div>
      )}
    </div>
  );
};

/** The binding, as a clause a title can carry, or nothing when it is not ours. */
function shortcutText(commandId: string, prefix = ' '): string {
  const shortcut = ownedShortcutFor(commandId);
  return shortcut ? `${prefix}(${shortcut})` : '';
}

/**
 * What the PDF menu's footer says: which document the viewer holds, and where it
 * is. Read from app state rather than from the pane, so the menu can be opened
 * before the viewer has ever mounted.
 */
const PdfStatusLine: React.FC<{ pdf: { path: string | null; page: number; pageCount: number } }> = ({ pdf }) => (
  <span style={{ color: 'var(--eu-fg-muted)' }}>
    {pdf.path ? pdf.path.replace(/^.*[\\/]/, '') : 'No PDF yet'}
    {pdf.pageCount > 0 ? ` · page ${pdf.page} of ${pdf.pageCount}` : ''}
  </span>
);

/* ------------------------------------------------------------- menu rendering */

/**
 * One of the toolbar's dropdowns.
 *
 * A menu rather than a second row of buttons: these are the presses that are
 * *not* the frequent one, and §55 is explicit that rarely used actions do not
 * get permanent space. Each entry names the same command the palette does, and
 * states its shortcut only when that shortcut is really the command's own — see
 * `ownedShortcutFor`.
 */
const ToolbarDropdown: React.FC<{
  testId: string;
  items: ToolbarMenuItem[];
  onRun(id: string): void;
  footer?: React.ReactNode;
}> = ({ testId, items, onRun, footer }) => (
  <div role="menu" data-testid={testId} className="eu-tab-bar__menu">
    {items.map((item) => {
      const shortcut = ownedShortcutFor(item.id);
      return (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-checked={item.checked}
          data-testid={`${testId}-${item.id}`}
          title={shortcut ? `${item.label} (${shortcut})` : item.label}
          onClick={() => onRun(item.id)}
          className="eu-tab-bar__menu-item"
        >
          <span className="eu-tab-bar__menu-icon">{item.icon}</span>
          <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
          {shortcut && <span className="eu-tab-bar__menu-shortcut">{shortcut}</span>}
        </button>
      );
    })}
    {footer && items.length > 0 && <div className="eu-tab-bar__menu-footer">{footer}</div>}
  </div>
);

/* --------------------------------------------------------------- styling */

/** Radius of the tab tops and the outward curves at the editor join. */
export const TAB_CORNER_RADIUS = 6;

export const TAB_BAR_HEIGHT = 35;
export const TAB_BAR_MAXIMIZED_HEIGHT = 32;

/**
 * The strip's own geometry.
 *
 * The height, and the two facts about the scroll container that no stylesheet can
 * state for it: it scrolls on one axis with the shell's easing, and it is a drag
 * region whose tabs opt out. Everything else — the surface, the tab hover, the
 * toolbar controls, the caption buttons, the dropdowns — is in
 * `ui/eukolia-shell.css`.
 *
 * There is deliberately no reservation on the right any more. It used to leave
 * 140px for the window controls `titleBarOverlay` painted over the bar; the
 * platform is no longer asked to paint them (`titleBarOverlay` is not configured
 * for this window) and the bar draws its own instead, so empty space there would
 * be 140px of nothing between the toolbar and the buttons that replaced it.
 */
const bar: React.CSSProperties = {
  height: TAB_BAR_HEIGHT
};

/**
 * The menu button that replaces the strip's leading padding while the panel bar
 * is collapsed. The 48px it expands to is the animation's own end state, so it
 * stays here beside the keyframes in `index.css`.
 */
const topLeftButtonWrapper: React.CSSProperties = {
  position: 'relative',
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  paddingLeft: 8,
  paddingRight: 6,
  flexShrink: 0,
  overflow: 'hidden',
  WebkitAppRegion: 'no-drag',
  animation: 'topLeftWrapperExpand 0.28s cubic-bezier(0.16, 1, 0.3, 1)'
} as React.CSSProperties;

// The tab bottoms align exactly with the bar; padding only extends the scroll clip.
const strip: React.CSSProperties = {
  height: 'calc(100% + var(--eu-tab-curve))',
  marginBottom: 'calc(-1 * var(--eu-tab-curve))'
};

export default TabBar;
