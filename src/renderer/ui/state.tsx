/**
 * Eukolia application state.
 *
 * A single React provider owns everything the shell renders: the workspace
 * snapshot, open documents, the file tree, diagnostics, build state, layout and
 * PDF state. Presentation components read it through `useAppState()` and never
 * touch services directly, which keeps them thin and testable.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { FileNode, RecentWorkspace } from '../../shared/ipc';
import type { OpenDocument, WorkspaceSnapshot } from '../services/workspace';
import { workspaceService } from '../services/instance';
import type { PdfZoomMode } from '../pdf/PdfViewer';
import { forgetAllLightPdfStates } from '../pdf/lightpdf-viewstate';
import { buildService, type BuildState, type RecipeOption } from '../services/build';
import { AutoBuildScheduler, type AutoBuildDecision } from '../services/autoBuild';
import { formatBuildFailure } from '../compiler/buildFailure';
import { bootstrapServices, reloadSnippets } from '../services/bootstrap';
import { projectIndex } from '../document/projectIndex';
import { commandRegistry, type CommandContext } from '../core/commands';
import { SETTING_CATEGORIES, settingsManager, setting } from '../core/settings';
import type { AutoSaveTrigger } from '../core/autoSave';
import { themeManager, type ThemeAppearance, type ThemeName, type ThemeSetting } from '../core/themes';
import { getSnippetEngine } from '../snippets/engine';
import { getSnippetStore } from '../snippets/store';
import { scheduleStartupReport, startupMark } from '../core/startupProbe';
import { setBootStatus } from '../core/bootScreen';
import type { DiagnosticItem } from '../compiler/logParser';
import type { OutlineItem } from '../document/analysisTypes';
import { sidebarShown } from './sidebarRegion';

export type LayoutMode = 'editor' | 'split' | 'visual-pdf' | 'source-visual' | 'pdf' | 'all';
export type EditorMode = 'code' | 'visual';
/**
 * The sidebar's views.
 *
 * `symbols` is the *Project* Symbols index — labels, citations, macros and
 * environments, used for navigation. `math-symbols` is a different panel with a
 * different job: a searchable catalog of mathematical notation that inserts into
 * the editor. They are two views because they are two intents, and the labels
 * say which is which.
 */
export type SidebarView = 'menu' | 'explorer' | 'outline' | 'search' | 'symbols' | 'math-symbols' | 'problems' | 'snippets';
export type BottomPanelView = 'problems' | 'output' | 'log' | 'search' | 'terminal';

/**
 * The sidebar's visibility rule lives in `sidebarRegion.ts`, which depends on
 * nothing, so that components and tests can read it without importing this
 * provider and the services it starts. Re-exported here because the provider is
 * where callers already look for it, and because `toggleSidebar` below is one of
 * the places that has to agree with it.
 */
export { sidebarShown, type SidebarRegionInput } from './sidebarRegion';

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
  matchLength: number;
}

export interface SearchState {
  query: string;
  replace: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  results: SearchHit[];
  running: boolean;
  truncated: boolean;
  durationMs: number;
  /** How many files the last search actually read. */
  filesScanned: number;
  error: string | null;
}

export interface PdfState {
  path: string | null;
  page: number;
  pageCount: number;
  zoom: number;
  /**
   * The viewer's zoom mode.
   *
   * Taken from the viewer rather than restated here: the union grew when
   * light-pdf's `fit-content`, `shrink-to-fit` and `automatic` modes were ported,
   * and a second copy of the list silently went stale. It is a type-only import,
   * so it is erased at build time and cannot introduce a runtime cycle.
   */
  zoomMode: PdfZoomMode;
  scrollTop: number;
  visible: boolean;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  searchMatches: number;
  outline: Array<{ title: string; page: number | null; depth: number }>;
  /**
   * Live preview, from the shell's side.
   *
   * `checkToken` is bumped by every finished build: the viewer answers it by
   * comparing the PDF's modification time against the one it recorded, so a
   * build that wrote nothing new costs one `stat` and no re-render. It also
   * polls the file on its own (`pdf.reloeadCheckIntervalMs`), which is what
   * notices a build done by another application.
   *
   * `forceToken` is the `PDF: Reload Document` command and light-pdf's `R`: an
   * unconditional re-open, for the case where the file did not change but the
   * viewer's copy of it is stale or suspected.
   */
  checkToken: number;
  forceToken: number;
}

/**
 * Applies a patch to the PDF state while keeping `page` inside the document.
 *
 * A newly opened, shorter PDF arrives as a `pageCount`-only patch (the pane's
 * `onDocumentLoaded`), while `page` is only ever moved by a view change — and a
 * document that arrives already laid out need not produce one. Without this the
 * toolbar and the status bar showed `Page 2 / 1` after a failing build replaced a
 * two-page document with a one-page one. A zero count means "no document yet",
 * so it leaves the page alone rather than pinning it to 1.
 */
export function patchPdfState(previous: PdfState, patch: Partial<PdfState>): PdfState {
  const next = { ...previous, ...patch };
  const pageCount = Math.max(0, next.pageCount);
  if (pageCount > 0 && next.page > pageCount) next.page = pageCount;
  if (next.page < 1) next.page = 1;
  return next;
}

export interface CursorState {
  line: number;
  column: number;
  offset: number;
  selectedChars: number;
}

export interface AppStateValue {
  ready: boolean;
  bootError: string | null;

  workspace: WorkspaceSnapshot;
  documents: OpenDocument[];
  activeDocument: OpenDocument | null;
  activeDoc: OpenDocument['doc'] | null;

  fileTree: FileNode[];
  outline: OutlineItem[];
  recentWorkspaces: RecentWorkspace[];

  diagnostics: DiagnosticItem[];
  build: BuildState;

  layout: LayoutMode;
  editorMode: EditorMode;
  sidebarView: SidebarView | null;
  sidebarVisible: boolean;
  bottomPanelVisible: boolean;
  bottomPanelView: BottomPanelView;
  /** The row of open-document tabs. */
  tabBarVisible: boolean;
  /** The line of build/cursor/tool state at the bottom of the window. */
  statusBarVisible: boolean;
  /**
   * The narrow strip of view icons down the left edge.
   *
   * Distinct from `sidebarVisible`, which is the view *beside* it: the strip is
   * how a view is chosen, the sidebar is what is shown once one is.
   */
  activityBarVisible: boolean;
  /** True while the bottom panel is showing the terminal view. */
  terminalVisible: boolean;
  pdf: PdfState;

  cursor: CursorState;
  theme: ThemeName;
  /**
   * The active theme's light/dark appearance. The parts of the app that only
   * distinguish two cases — the ported editor theme, the PDF pane, the default
   * PDF inversion — read this instead of knowing every theme by name.
   */
  themeAppearance: ThemeAppearance;
  themeSetting: ThemeSetting;

  search: SearchState;
  statusMessage: string | null;

  paletteOpen: boolean;
  quickOpenOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  aboutOpen: boolean;
  buildPickerOpen: boolean;
  /**
   * Whether the snippet library window is showing.
   *
   * Its own window rather than a section of Settings: managing snippets is a task
   * with an end, and the window is where the end is — closing it writes what was
   * changed.
   */
  snippetsOpen: boolean;
  /**
   * The entry the library window should open on, when something pointed at one.
   *
   * The sidebar's history knows which snippet fired, which is exactly the entry a
   * reader wants to change; naming it here is what makes "open that one" possible
   * without the manager having to guess.
   */
  snippetFocusId: string | null;
  /**
   * The recipes the build picker offers, with their availability.
   *
   * Read from the build service rather than written here: the service derives
   * them from the same settings the resolver reads, so a name in this list is a
   * name the resolver knows, and `available` says whether the machine has the
   * tools it needs.
   */
  activeRecipes: RecipeOption[];
  activeRecipeName: string | null;
  tools: Array<{ name: string; available: boolean; version: string | null; path: string | null }>;

  // Actions
  openFolder(path?: string): Promise<void>;
  openFile(path?: string, line?: number, column?: number): Promise<void>;
  closeDocument(uri: string): Promise<void>;
  setActiveDocument(uri: string): void;
  save(document?: OpenDocument['doc']): Promise<boolean>;
  saveAs(document?: OpenDocument['doc']): Promise<boolean>;
  saveAll(): Promise<number>;
  /**
   * Reports an autosave trigger to the workspace (`files.autoSave`).
   *
   * The shell says *what happened* — the editor lost focus, the window did — and
   * the mode decides whether that is a write; `autoSaveRunsFor` in
   * `core/autoSave.ts` is that decision. Returns the number of buffers written,
   * which is 0 whenever the current mode does not act on this trigger.
   */
  runAutoSave(trigger: AutoSaveTrigger, uri?: string): Promise<number>;
  newFile(content?: string): void | Promise<void>;
  reopenClosedEditor(): Promise<void>;
  goToRootDocument(): Promise<void>;

  setLayout(layout: LayoutMode): void;
  setEditorMode(mode: EditorMode): void;
  /**
   * Shows a sidebar view, or hides the sidebar when `view` is `null`.
   *
   * This is the activity bar's action, so it is also what leaves the settings
   * pane: choosing a view is a request to *go there*, and the activity bar stays
   * mounted while settings is open precisely so a view can be reached from inside
   * it. Without this the pane stayed up and the click appeared to do nothing.
   */
  setSidebarView(view: SidebarView | null): void;
  toggleSidebar(): void;
  /**
   * Reveals the sidebar, dismissing the settings pane if it is covering the
   * slot. Unlike `toggleSidebar` this never collapses it, so a command that
   * means "show me the explorer" cannot accidentally hide it.
   */
  showSidebar(): void;
  toggleBottomPanel(view?: BottomPanelView): void;
  setBottomPanelView(view: BottomPanelView): void;
  /** Shows or hides the row of document tabs. */
  toggleTabBar(): void;
  /** Shows or hides the status line. */
  toggleStatusBar(): void;
  /** Shows or hides the activity bar. */
  toggleActivityBar(): void;
  /** Toggles whether panel buttons stay visible or collapse with the sidebar. */
  togglePanelBar(): void;
  /**
   * Enters Focus Mode, or leaves it for the split layout.
   *
   * The layout commands (`view.sourcePdf` and the five others) each *set* a
   * layout, which is right for a menu entry naming a destination and wrong for
   * Focus Mode, whose control is pressed from this state and has to leave it. One
   * command, one key and one menu entry is also the only shape that works: two
   * commands on one binding resolve to whichever registered first, which is how
   * the first version of this feature left the toggle unreachable from the
   * keyboard.
   */
  toggleFocusMode(): void;
  /** Shows or hides the integrated terminal. */
  toggleTerminal(): void;
  setTerminalVisible(visible: boolean): void;

  buildProject(options?: { recipeName?: string; rootFile?: string; force?: boolean }): Promise<void>;
  cancelBuild(): Promise<void>;
  cleanBuild(): Promise<void>;
  cleanAndBuild(): Promise<void>;
  /**
   * Builds again with every `latexmk` rule forced.
   *
   * Distinct from Build on purpose: latexmk decides for itself whether a rule
   * needs to run, which is what makes an unchanged document build in a fraction
   * of a second — and what makes a build that *should* have picked something up
   * look like it did nothing. Rebuild is the answer to the second case, and it
   * is the only thing `compilation.latexmk.minimumRule` was ever meant to
   * describe.
   */
  rebuildProject(): Promise<void>;
  detectRecipes(): Promise<void>;

  setPdfVisible(visible: boolean): void;
  setPdfPath(path: string | null): void;
  setPdfState(patch: Partial<PdfState>): void;
  /**
   * Reloads the PDF the viewer is showing.
   *
   * `force` is light-pdf's `Reload Document` (`R`): re-open the file whether or
   * not its modification time moved — the answer to "the pane is showing
   * something that is not what is on disk". Without it the viewer simply checks,
   * which is what a finished build asks for.
   */
  reloadPdf(force?: boolean): void;

  runSearch(): Promise<void>;
  setSearch(patch: Partial<SearchState>): void;
  replaceAll(): Promise<void>;

  setCursor(cursor: CursorState): void;
  setTheme(theme: ThemeSetting): void;
  /** Steps to the next theme in THEME_NAMES; the status bar's theme control. */
  cycleTheme(): void;
  setSetting(key: string, value: unknown): void;
  setStatusMessage(message: string | null): void;

  setPaletteOpen(open: boolean): void;
  setQuickOpenOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  /** Which category or synthetic section the settings pane is showing. */
  settingsSection: string;
  /**
   * Opens the settings pane, or closes it when it is already open.
   *
   * Every control that leads *to* settings goes through this rather than
   * `setSettingsOpen(true)`, so a second press on the control the user arrived
   * by takes them back — which is what every other toggle in this application
   * does, and what a user expects of the entry they just clicked.
   */
  toggleSettings(): void;
  /**
   * Shows a settings section — a category, or one of the synthetic sections that
   * replace the pane's body — or steps back to the category list when it is
   * already the one showing.
   */
  openSettingsSection(section: string): void;
  setShortcutsOpen(open: boolean): void;
  setAboutOpen(open: boolean): void;
  setBuildPickerOpen(open: boolean): void;
  setSnippetsOpen(open: boolean): void;
  /**
   * Registers the active SnippetManager's requestClose callback.
   * When toggleSnippets() or an outside close is requested while snippets are open,
   * this handler is invoked so state is remembered and changes are saved.
   */
  registerSnippetsCloseHandler(handler: () => Promise<boolean>): () => void;
  /**
   * Shows the snippet library window, or closes it when it is already showing.
   *
   * Closing it is what writes the library (see `SnippetManager`), so this is the
   * action the keyboard shortcut, the settings entry and the sidebar's gear all
   * take: one way in, and the same way out.
   */
  toggleSnippets(): void;
  /**
   * Shows the library window on one entry — the snippet a history row names, so
   * "what did that, and how do I change it?" is one click rather than a search
   * through several hundred rows.
   */
  openSnippetInManager(id: string): void;

  revealInEditor(line: number, column?: number): void;
  goToSource(file: string, line: number, column?: number): Promise<void>;
  /**
   * The editor the application drives: SyncTeX, the breadcrumbs, the VS Code
   * host bridge and the editor commands all resolve positions through it. It is
   * engine-neutral (`src/renderer/editor/editorHandle.ts`) because the editor
   * behind it is the CodeMirror host in whichever mode is active.
   */
  editorHandleRef: React.MutableRefObject<import('../editor/editorHandle').EditorHandle | null>;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside <AppStateProvider>');
  return value;
}

export function useOptionalAppState(): AppStateValue | null {
  return useContext(AppStateContext);
}

const EMPTY_WORKSPACE: WorkspaceSnapshot = {
  workspacePath: null,
  workspaceName: null,
  documents: [],
  activeUri: null,
  recentWorkspaces: [],
  building: false
};

const INITIAL_PDF: PdfState = {
  path: null,
  page: 1,
  pageCount: 0,
  zoom: 1,
  zoomMode: 'page-width',
  scrollTop: 0,
  visible: true,
  loading: false,
  error: null,
  searchQuery: '',
  searchMatches: 0,
  outline: [],
  checkToken: 0,
  forceToken: 0
};

const INITIAL_SEARCH: SearchState = {
  query: '',
  replace: '',
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: '*.tex',
  results: [],
  running: false,
  truncated: false,
  durationMs: 0,
  filesScanned: 0,
  error: null
};

export const AppStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(EMPTY_WORKSPACE);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [build, setBuild] = useState<BuildState>(buildService.getState());
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [layout, setLayoutState] = useState<LayoutMode>('split');
  const [editorMode, setEditorModeState] = useState<EditorMode>('code');
  const [sidebarView, setSidebarViewState] = useState<SidebarView | null>('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [bottomPanelVisible, setBottomPanelVisible] = useState(false);
  const [bottomPanelView, setBottomPanelView] = useState<BottomPanelView>('problems');
  // Chrome that can be shown or hidden: the tab strip, the status line and the
  // terminal. Each has a shortcut, rebindable in settings. The terminal is a
  // view of the bottom panel, so "visible" is derived rather than stored: it is
  // true exactly while that panel is open on the terminal view.
  const [tabBarVisible, setTabBarVisible] = useState(true);
  // The status bar and the activity bar are also settings
  // (`appearance.showStatusBar`, `appearance.showActivityBar`), so they start
  // from those rather than from a hard-coded `true`. The setting is the
  // persisted preference and the toggle writes it back, which is what stops the
  // two from disagreeing: before this the settings existed in the Settings UI
  // and nothing read them, so flipping one did nothing at all.
  const [statusBarVisible, setStatusBarVisible] = useState(() => setting.bool('appearance.showStatusBar'));
  const [activityBarVisible, setActivityBarVisible] = useState(() => setting.bool('appearance.showActivityBar'));
  const terminalVisible = bottomPanelVisible && bottomPanelView === 'terminal';
  const [pdf, setPdf] = useState<PdfState>(INITIAL_PDF);
  const [cursor, setCursorState] = useState<CursorState>({ line: 1, column: 1, offset: 0, selectedChars: 0 });
  const [theme, setThemeState] = useState<ThemeName>(themeManager.getActiveTheme());
  const [themeAppearance, setThemeAppearanceState] = useState<ThemeAppearance>(themeManager.getAppearance());
  const [themeSetting, setThemeSettingState] = useState<ThemeSetting>((setting.str('general.theme') as ThemeSetting) ?? 'system');
  const [search, setSearchState] = useState<SearchState>(INITIAL_SEARCH);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Which section the settings pane is showing.
   *
   * A setting category, or the synthetic `SHORTCUTS_SECTION` that replaces the
   * settings body. (The snippet library used to be the second of those; it is a
   * window of its own now, and has its own state below.) It lives here rather
   * than inside `SettingsView` so that Escape can be resolved in one place: two
   * listeners both watching for Escape would otherwise close both the section
   * *and* the pane on a single press.
   */
  const [settingsSection, setSettingsSection] = useState<string>(SETTING_CATEGORIES[0]);
  /**
   * The settings pane's own toggle.
   *
   * The functional update is what makes it correct on the *first* press as well
   * as the second: a handler that read `settingsOpen` from its closure would need
   * to close over the current value, and every caller that captured a stale one
   * would silently stop toggling.
   */
  const toggleSettings = useCallback(() => setSettingsOpen((open) => !open), []);

  /**
   * Opens a settings section, or goes back to the category list when it is
   * already the one showing.
   *
   * The synthetic sections replace the pane's whole body, so the entry that led
   * there has to be the way back as well. Opening one also dismisses the command
   * palette and quick open, which are overlays *over* the pane: leaving them up
   * would mean the click had visibly done nothing, which is the bug this whole
   * area exists to fix.
   */
  const openSettingsSection = useCallback((target: string) => {
    setSettingsOpen(true);
    setPaletteOpen(false);
    setQuickOpenOpen(false);
    setSettingsSection((current) => (current === target ? SETTING_CATEGORIES[0] : target));
  }, []);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [buildPickerOpen, setBuildPickerOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [snippetFocusId, setSnippetFocusId] = useState<string | null>(null);
  const snippetsCloseHandlerRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerSnippetsCloseHandler = useCallback((handler: () => Promise<boolean>) => {
    snippetsCloseHandlerRef.current = handler;
    return () => {
      if (snippetsCloseHandlerRef.current === handler) {
        snippetsCloseHandlerRef.current = null;
      }
    };
  }, []);
  /**
   * Opens the snippet library, or closes it when it is already open.
   *
   * The window is modal, so opening it dismisses the palette and quick open:
   * leaving an overlay up behind a modal one would mean the click had visibly
   * done nothing, and the modal one is the one that has to be answered.
   */
  const toggleSnippets = useCallback(() => {
    if (snippetsOpen) {
      if (snippetsCloseHandlerRef.current) {
        void snippetsCloseHandlerRef.current();
        return;
      }
      const store = getSnippetStore();
      if (store.getSnapshot().dirty) {
        void store.flush();
      }
      setSnippetsOpen(false);
      return;
    }
    setPaletteOpen(false);
    setQuickOpenOpen(false);
    setSnippetFocusId(null);
    setSnippetsOpen(true);
  }, [snippetsOpen]);
  const openSnippetInManager = useCallback((id: string) => {
    setSnippetFocusId(id);
    setPaletteOpen(false);
    setQuickOpenOpen(false);
    setSnippetsOpen(true);
  }, []);
  const [activeRecipes, setActiveRecipes] = useState<RecipeOption[]>([]);
  const [activeRecipeName, setActiveRecipeName] = useState<string | null>(null);
  const [tools, setTools] = useState<AppStateValue['tools']>([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  /**
   * The detected root document, mirrored into state so the session capture below
   * can depend on it.
   *
   * Detection is asynchronous (`openFolder` does not wait for it), so the first
   * session write happens before the answer exists. Without this mirror the
   * capture has no dependency that changes when detection lands, and the
   * remembered root is written as `null` on every launch — which is the field
   * that exists so the *next* launch does not have to re-derive it.
   */
  const [rootFileDoc, setRootFileDoc] = useState<string | null>(null);

  const editorHandleRef = useRef<import('../editor/editorHandle').EditorHandle | null>(null);
  const activeDocRef = useRef<OpenDocument | null>(null);

  const refreshOutline = useCallback(() => {
    const active = workspaceService.getActiveDocument();
    setOutline(active ? projectIndex.getOutline() : []);
  }, []);

  /**
   * Shows the root document's PDF, if it has already been built.
   *
   * A `stat` across the bridge, and it was on the path to the first frame for no
   * reason: the answer only decides whether the viewer opens on the last build's
   * output, and the shell is equally correct without it. It runs after `ready`, so
   * the round trip happens while the user is looking at the application rather
   * than at a loading screen.
   */
  const adoptRootDocumentPdf = useCallback(async () => {
    const root = projectIndex.getRootDocumentPath();
    if (!root) return;
    try {
      const detected = await window.eukoliaApi.stat(root);
      if (detected.exists) {
        setPdf((previous) => ({ ...previous, path: root.replace(/\.(tex|ltx)$/i, '.pdf') }));
      }
    } catch {
      /* an unreadable root is reported by the scan, not here */
    }
    startupMark('state:root-pdf-checked');
  }, []);

  /**
   * Gives the build service its plan resolver.
   *
   * The resolver is a dynamic import of the module that resolves a build plan —
   * the ported LaTeX Workshop recipe machinery — and a build cannot start before
   * the user has asked for one, so nothing is waiting for it at startup. The
   * recipe list is not set here: it is derived by the same service from the
   * settings, and `detectRecipes` below is what refreshes it against the tools
   * this machine actually has.
   */
  const adoptBuildPlanResolver = useCallback(async () => {
    const { resolveBuildPlan } = await import('../services/bootstrap');
    buildService.setPlanResolver(resolveBuildPlan);
    setActiveRecipes(buildService.refreshRecipes());
    startupMark('state:build-resolver-set');
  }, []);

  // ------------------------------------------------------------------ startup

  useEffect(() => {
    let disposed = false;

    const start = async () => {
      try {
        /*
         * The analyzer and the snippet library are both started here and neither
         * is awaited on the path to the first paint.
         *
         * They are the two things that make startup slow and the two things
         * nothing on the opening screen depends on: the ported LaTeX Workshop
         * parser is 1.5 MB of the entry bundle and only a document needs it, and
         * the snippet library is a file read that only an expansion needs.
         * `bootstrapServices` publishes the theme and wires the commands
         * synchronously; `whenReady` is what the two background loads join on.
         */
        const analyzerLoad = workspaceService.beginAnalyzerLoad();
        const ready = bootstrapServices();
        setBootStatus('Reading your session…');
        const persisted = await window.eukoliaApi.getState();
        startupMark('state:persisted-read');

        setBootStatus(persisted.workspacePath ? 'Restoring your project…' : 'Preparing the editor…');
        await workspaceService.restoreSession({
          workspacePath: persisted.workspacePath,
          openFiles: persisted.openFiles,
          activeFile: persisted.activeFile,
          rootFile: persisted.rootFile ?? null,
          recentWorkspaces: persisted.recentWorkspaces,
          unsavedBuffers: persisted.unsavedBuffers
        });

        if (disposed) return;
        setRecentWorkspaces(persisted.recentWorkspaces ?? []);

        /*
         * Nothing else on this path.
         *
         * What is left between here and `ready` is what the shell cannot be drawn
         * correctly without: the persisted UI choices (they arrive with the rest
         * of the session, before this) and the documents that are already open.
         * Everything else — the plan resolver's dynamic import, the tool
         * detection, whether the root document's PDF exists, the snippet library,
         * the parser — is started *after* the flag is set, so the loading screen
         * hands over to the first frame the application can honestly draw.
         *
         * The difference is measurable and was measured: the `stat` for the PDF
         * alone is an IPC round trip, and an `await` for it here is a round trip
         * the user watches.
         */
        startupMark('state:ready');
        setReady(true);
        scheduleStartupReport();

        // Secondary services, in the order their results become visible. None of
        // them is awaited: the shell is on screen by now and every one of these
        // ends in a state update.
        void ready.then(
          () => startupMark('state:bootstrap-settled'),
          (error) => console.warn('[eukolia] service bootstrap failed', error)
        );
        void analyzerLoad.then(
          () => startupMark('state:analyzer-ready'),
          () => undefined
        );
        void adoptRootDocumentPdf();
        void adoptBuildPlanResolver();
        // Tool detection shells out, so it runs after the window is interactive
        // rather than delaying first paint.
        void detectRecipes();
      } catch (err) {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        startupMark('state:ready-with-error');
        setBootError(message);
        setReady(true);
        scheduleStartupReport();
        void window.eukoliaApi.log('error', `startup failed: ${message}`);
      }
    };

    startupMark('state:start');
    setBootStatus('Starting…');
    void start();
    return () => {
      disposed = true;
    };
  }, []);

  // -------------------------------------------------------- service listeners

  useEffect(() => {
    const offWorkspace = workspaceService.on('change', (snapshot: WorkspaceSnapshot) => {
      setWorkspace(snapshot);
      const active = workspaceService.getActive() ?? null;
      activeDocRef.current = active;
      refreshOutline();
    });

    const offTree = workspaceService.on('tree-change', (tree: FileNode[]) => setFileTree(tree));
    const offActive = workspaceService.on('active-change', () => {
      activeDocRef.current = workspaceService.getActive() ?? null;
      refreshOutline();
    });
    const offClosed = workspaceService.on('closed', () => setOutline(projectIndex.getOutline()));
    const offIndex = projectIndex.on('index-change', () => refreshOutline());
    const offRoot = projectIndex.on('root-document-change', (root: string | null) => {
      setRootFileDoc(root);
      if (root) setPdf((previous) => ({ ...previous, path: root.replace(/\.(tex|ltx)$/i, '.pdf'), zoomMode: 'page-width' }));
    });

    const offBuild = buildService.on('state', (next: BuildState) => {
      setBuild(next);
      setDiagnostics(next.diagnostics);
      /*
       * A failed build opens the panel on the view that can explain it.
       *
       * The Problems list is the right answer when the compiler blamed a source
       * line — that is the thing to fix, and clicking it goes there. When the
       * build failed before any compiler ran (an engine that is not installed, a
       * recipe naming a tool that does not exist) there is nothing to blame and
       * the Problems list holds only the build's own failure entry, so the
       * *Output* view is shown: the command that could not be started, its exit
       * code and the reason are all there. Opening an empty Problems list under
       * the word "failed" is what made a failure unreadable.
       */
      if (next.status === 'failed') {
        setBottomPanelVisible(true);
        setBottomPanelView(next.diagnostics.some((item) => item.line > 0) ? 'problems' : 'output');
        // The exact failure, not "Build failed": this is the line the reader
        // acts on, and it is the same sentence the panel prints.
        if (next.failure) setStatusMessage(formatBuildFailure(next.failure));
      }
      if (next.pdfPath) {
        setPdf((previous) => ({ ...previous, path: next.pdfPath!, error: null }));
      }
      /*
       * A finished build is a change to the PDF, and the viewer is told at once.
       *
       * The viewer also polls the file's modification time, which is what picks
       * up a build done by something else (VS Code, a script, `latexmk` in the
       * terminal), but a build *this* application ran does not have to wait for a
       * poll to come round: it knows the file was just written. The signal is a
       * *check*, not a reload — the viewer compares the modification time it
       * recorded against the one on disk, so a build that wrote nothing new
       * (latexmk reporting "nothing to do") costs one `stat` and no re-render.
       *
       * It is sent for every outcome, because a failed build still writes a PDF
       * more often than not: a document with an undefined control sequence
       * produces a page in nonstop mode, and leaving the pane on the previous
       * version of it is the one thing the reader does not want.
       */
      if (next.status !== 'running' && (next.pdfPath || next.startedAt !== null)) {
        setPdf((previous) => ({ ...previous, checkToken: previous.checkToken + 1 }));
      }
    });
    const offBuildError = buildService.on('error', (message: string) => setStatusMessage(message));

    /*
     * Automatic builds.
     *
     * One scheduler, two triggers, three modes (`services/autoBuild.ts`): a save
     * in the editor, and a change to a watched file on disk — which includes the
     * save, because a save *is* a change to a file. The scheduler owns the
     * debounce, the "never two builds at once" rule and the minimum interval, and
     * it refuses the triggers that must not build (the build's own output above
     * all, or a compile would trigger itself forever).
     */
    const autoBuild = new AutoBuildScheduler({
      build: () => {
        void buildService.build({});
      },
      isRunning: () => buildService.isRunning(),
      delayMs: () => setting.num('compilation.autoBuildDelayMs'),
      minIntervalMs: () => setting.num('compilation.autoBuildMinIntervalMs'),
      // A manual Ctrl+B resets the interval too: the automatic build of the same
      // sources, a moment later, is exactly the build nobody asked for.
      lastBuildStartedAt: () => buildService.getState().startedAt,
      onDecision: (decision: AutoBuildDecision & { trigger: string; path: string }) => {
        // Nothing is logged for the ordinary refusal of an artefact — a build
        // writes a dozen of them and each one would produce a line. Everything
        // else is worth a line in the log the support conversation reads.
        if (decision.reason === 'ok' || decision.reason === 'build-artefact') return;
        void window.eukoliaApi.log('info', `[autobuild] ignored ${decision.trigger} of ${decision.path}: ${decision.reason}`);
      }
    });
    const autoBuildContext = () => ({
      mode: setting.str('compilation.autoBuild'),
      rootFile: projectIndex.getRootDocumentPath(),
      ignore: setting.list('compilation.autoBuildIgnore')
    });
    const offSaved = workspaceService.on('saved', (uri: string) => {
      autoBuild.request('save', uri, autoBuildContext());
    });
    const offWatch = window.eukoliaApi.onFileWatchEvent((event) => {
      void workspaceService.handleExternalChange(event);
      if (event.kind !== 'delete') autoBuild.request('external-change', event.path, autoBuildContext());
    });

    return () => {
      offWorkspace();
      offTree();
      offActive();
      offClosed();
      offIndex();
      offRoot();
      offBuild();
      offBuildError();
      offSaved();
      offWatch();
      autoBuild.dispose();
    };
  }, [refreshOutline]);

  /*
   * A watcher that stopped watching.
   *
   * The project is no longer being noticed when this fires, which is invisible
   * otherwise — the tree simply stops updating — so the one code VS Code puts in
   * front of the user is put in front of the user here too, in its wording
   * (`userMessage`). Every code is in the log; the rest are not shown, because
   * upstream does not show them either and a message nobody can act on is noise.
   */
  useEffect(() => {
    const off = window.eukoliaApi.onFileWatchError((event) => {
      if (event.userMessage) setStatusMessage(event.userMessage);
    });
    return off;
  }, []);

  // Protocol and menu commands from the main process.
  useEffect(() => {
    const offFile = window.eukoliaApi.onProtocolOpenFile((payload) => {
      const request = payload as unknown as { path: string; line?: number; column?: number } | string;
      if (typeof request === 'string') void workspaceService.openFile(request);
      else void workspaceService.openFile(request.path, { line: request.line, column: request.column });
    });
    const offProject = window.eukoliaApi.onProtocolOpenProject((projectPath) => {
      void openFolder(projectPath);
    });
    return () => {
      offFile();
      offProject();
    };
    // `openFolder` is stable; it only calls the workspace service.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ actions

  const openFolder = useCallback(async (folderPath?: string) => {
    const target = folderPath ?? (await window.eukoliaApi.openFolderDialog());
    if (!target) return;
    setStatusMessage(`Opening ${target}…`);
    try {
      forgetAllLightPdfStates();
      await workspaceService.saveAll();
      await workspaceService.openFolder(target);
      /*
       * The snippet library is loaded *after* the project is on screen, not in front
       * of it.
       *
       * This awaited a read and parse of every snippet source before the shell was
       * allowed to appear — the user's library is a quarter of a megabyte of JSON plus
       * a 70 KB globals script, projected into the engine's own format — and nothing
       * before the first keystroke needs any of it. Measured on the profiler, a
       * configured project took **1 614–1 947 ms** to reach the shell with 54 % of the
       * renderer's samples *idle*: not one hot function, a chain of round-trips, and
       * this was one of them.
       *
       * Nothing is skipped — the load starts one statement later and runs while the
       * reader is looking at their document. Between the two there is a window in which
       * a snippet typed at the very first keystroke would not fire; the same window
       * exists today while the load is in flight, and it is now measured in
       * milliseconds after a paint rather than blocking it.
       */
      void reloadSnippets();
      const active = workspaceService.getActive();
      const root = projectIndex.getRootDocumentPath();
      const pdfTarget = (active && /\.tex$/i.test(active.doc.filename)) ? active.doc.uri : root;
      if (pdfTarget) {
        setPdf((previous) => ({
          ...previous,
          path: pdfTarget.replace(/\.(tex|ltx)$/i, '.pdf'),
          zoomMode: 'page-width',
          page: 1
        }));
      } else {
        setPdf((previous) => ({
          ...previous,
          path: null,
          zoomMode: 'page-width',
          page: 1,
          pageCount: 0
        }));
      }
      /*
       * The recent-workspace list and the end of the "Opening …" message are the last
       * things in the chain, and both are cosmetic: the message is cleared before the
       * state round-trip rather than after it, so the bar is not left saying "Opening"
       * over an editor that is already open.
       */
      setStatusMessage(null);
      const state = await window.eukoliaApi.getState();
      setRecentWorkspaces(state.recentWorkspaces ?? []);
    } catch (err) {
      setStatusMessage(`Could not open folder: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const openFile = useCallback(async (filePath?: string, line?: number, column?: number) => {
    const targets = filePath ? [filePath] : await window.eukoliaApi.openFileDialog();
    for (const target of targets) {
      await workspaceService.openFile(target, { line, column });
    }
  }, []);

  // Launch requests received during library setup wait until session restoration
  // has completed. Subscriptions above are installed before marking main ready.
  useEffect(() => {
    if (!ready) return;
    void window.eukoliaApi.takePendingProtocolRequests?.().then(async requests => {
      for (const request of requests) {
        if (request.kind === 'project') await openFolder(request.path);
        else await openFile(request.path, request.line, request.column);
      }
    }).catch(error => setStatusMessage(`Could not open launch request: ${String(error)}`));
  }, [ready, openFolder, openFile]);

  const closeDocument = useCallback(async (uri: string) => {
    const entry = workspaceService.getOpenDocuments().find((candidate) => candidate.doc.uri === uri);
    if (!entry) return;
    if (entry.doc.getDirty()) {
      const decision = await workspaceService.promptSaveIfDirty(uri);
      if (decision === 'cancelled') return;
    }
    workspaceService.closeDocument(uri, { force: true });
  }, []);

  const setActiveDocument = useCallback((uri: string) => workspaceService.setActive(uri), []);

  const save = useCallback((document?: OpenDocument['doc']) => workspaceService.save(document), []);
  const saveAs = useCallback((document?: OpenDocument['doc']) => workspaceService.saveAs(document), []);
  const saveAll = useCallback(() => workspaceService.saveAll(), []);
  const runAutoSave = useCallback((trigger: AutoSaveTrigger, uri?: string) => workspaceService.runAutoSave(trigger, uri), []);
  const newFile = useCallback(async (content = '') => {
    try {
      const uri = await workspaceService.createProjectNewFile(content);
      const name = uri.split(/[\\/]/).pop() ?? uri;
      setStatusMessage(`Created ${name}`);
    } catch (err) {
      setStatusMessage(`Could not create file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const reopenClosedEditor = useCallback(async () => {
    const uri = await workspaceService.reopenLastClosed();
    if (uri) {
      setStatusMessage(`Reopened ${uri.split(/[\\/]/).pop()}`);
    } else {
      setStatusMessage('No recently closed editors');
    }
  }, []);

  const goToRootDocument = useCallback(async () => {
    const root = projectIndex.getRootDocumentPath();
    if (root) {
      await workspaceService.openFile(root);
      setStatusMessage(`Opened root document: ${root.split(/[\\/]/).pop()}`);
    } else {
      setStatusMessage('No root document detected');
    }
  }, []);

  const setLayout = useCallback((next: LayoutMode) => {
    setLayoutState(next);
    // Every layout except Focus Mode shows the PDF pane.
    setPdf((previous) => ({ ...previous, visible: next !== 'editor' }));
  }, []);

  const setEditorMode = useCallback((mode: EditorMode) => {
    setEditorModeState(mode);
    commandRegistry.setContext({ editorMode: mode });
  }, []);

  /**
   * Leaves whatever the user was looking at and shows a sidebar view.
   *
   * "Choose where to look" is one decision, so it is one state transition: the
   * settings pane comes down, the sidebar goes up on the chosen view, and the
   * two overlays that sit above everything (the palette and quick open) close as
   * well. Writing only `sidebarView` is what made the activity bar look inert —
   * the view changed behind a pane that never came down.
   */
  const showView = useCallback((view: SidebarView | null) => {
    setSettingsOpen(false);
    setPaletteOpen(false);
    setQuickOpenOpen(false);
    setSidebarViewState(view);
    setSidebarVisible(view !== null);
  }, []);

  const setSidebarView = useCallback((view: SidebarView | null) => showView(view), [showView]);

  /**
   * Brings the sidebar region on screen: the views are visible and no longer
   * covered.
   *
   * `sidebarShown` answers "is it on screen?", which is not the same question as
   * "did the user ask for it?". Any surface that promises to reveal the sidebar
   * needs the first one, so it goes through here rather than writing
   * `sidebarVisible` and hoping nothing else is in the way.
   */
  const showSidebar = useCallback(() => {
    setSidebarVisible(true);
    // The settings pane replaces the sidebar's slot, so asking for the sidebar
    // while it is open has to dismiss it — the same rule `showView` follows for
    // view changes, and what makes the request one the screen can honour.
    setSettingsOpen(false);
  }, []);

  /**
   * Collapses the sidebar region or brings it back.
   *
   * Every element of the region moves together — the view panel holds Explorer,
   * Search, Outline, Symbols, Snippets and Problems, and they are shown or
   * hidden by this one flag — so the toggle is a statement about the whole
   * region and must be true of it in both directions.
   *
   * It is written against `sidebarShown` rather than the `sidebarVisible` flag
   * because those part company: with the settings pane up, or with no view ever
   * chosen, the flag can say "visible" while the screen shows nothing. Keying
   * off the flag there would make the toggle a no-op — pressed on a hidden
   * sidebar, and it stays hidden — which is exactly the failure this avoids.
   */
  const toggleSidebar = useCallback(() => {
    if (sidebarShown({ visible: sidebarVisible, view: sidebarView, settingsOpen })) {
      setSidebarVisible(false);
      return;
    }
    // A sidebar with no view chosen would come back to an empty panel, so it
    // comes back on Explorer instead.
    if (sidebarView === null) setSidebarViewState('explorer');
    // Going through `showSidebar` covers the third case: the flag says visible
    // but the settings pane is over the top, so the region is hidden. Asking for
    // it has to take the pane down or the toggle would report success while the
    // sidebar stayed covered.
    showSidebar();
  }, [sidebarVisible, sidebarView, settingsOpen, showSidebar]);

  const toggleBottomPanel = useCallback((view?: BottomPanelView) => {
    setBottomPanelVisible((visible) => {
      if (view) setBottomPanelView(view);
      return view ? true : !visible;
    });
  }, []);

  const toggleTabBar = useCallback(() => setTabBarVisible((visible) => !visible), []);
  // `settingsManager.setValue` is called outside the state updater on purpose:
  // an updater may run twice under StrictMode, and writing a setting from one
  // would double-write.
  const toggleStatusBar = useCallback(() => {
    const next = !statusBarVisible;
    setStatusBarVisible(next);
    settingsManager.setValue('appearance.showStatusBar', next);
  }, [statusBarVisible]);
  const toggleActivityBar = useCallback(() => {
    const next = !activityBarVisible;
    setActivityBarVisible(next);
    settingsManager.setValue('appearance.showActivityBar', next);
  }, [activityBarVisible]);
  const togglePanelBar = useCallback(() => {
    const current = Boolean(settingsManager.getValue('appearance.collapseActivityBarWithSidebar') ?? true);
    settingsManager.setValue('appearance.collapseActivityBarWithSidebar', !current);
  }, []);
  /**
   * Focus Mode as a toggle rather than a destination.
   *
   * `view.focusMode` is the command; this is what it runs, and the tab bar's
   * button and the View menu entry both go through it, so the keyboard and the
   * control share one implementation. Leaving Focus Mode returns to the split
   * layout — the one laid out for "source beside its output" — and restores the
   * PDF pane with it, since `setLayout` shows the viewer in every layout but
   * Focus Mode.
   */
  const toggleFocusMode = useCallback(() => {
    setLayout(layout === 'editor' ? 'split' : 'editor');
  }, [layout, setLayout]);
  /**
   * Shows the bottom panel on the terminal view, and hides the panel again only
   * when the terminal is the view already showing; from any other view — or
   * from a hidden panel — it switches to the terminal instead of closing it.
   */
  const toggleTerminal = useCallback(() => {
    if (bottomPanelVisible && bottomPanelView === 'terminal') {
      setBottomPanelVisible(false);
      return;
    }
    setBottomPanelView('terminal');
    setBottomPanelVisible(true);
  }, [bottomPanelVisible, bottomPanelView]);
  const setTerminalVisibleValue = useCallback(
    (visible: boolean) => {
      if (visible) {
        setBottomPanelView('terminal');
        setBottomPanelVisible(true);
      } else {
        // Nothing to close when another view owns the panel.
        setBottomPanelVisible((current) => (bottomPanelView === 'terminal' ? false : current));
      }
    },
    [bottomPanelView]
  );

  const buildProject = useCallback(async (options?: { recipeName?: string; rootFile?: string; force?: boolean }) => {
    setBottomPanelVisible(true);
    setBottomPanelView('output');
    // An explicit root wins, so a chapter or a scratch file can be built on its
    // own without changing the project's detected root document.
    const root = options?.rootFile ?? projectIndex.getRootDocumentPath() ?? workspaceService.getActiveDocument()?.uri ?? null;
    const result = await buildService.build({
      rootFile: root ?? undefined,
      recipeName: options?.recipeName,
      force: options?.force
    });
    if (result?.success) {
      setPdf((previous) => ({ ...previous, path: result.pdfPath ?? previous.path, error: null }));
      setStatusMessage(`Build succeeded in ${result.durationMs} ms`);
      if (setting.bool('pdf.jumpToPdfOnBuild')) setLayout('split');
    }
    /*
     * Nothing is written here for the other two outcomes.
     *
     * `buildService` publishes the exact failure — which command, which exit
     * code, which reason — and the listener above puts that sentence in the
     * status bar and opens the panel on the view that explains it. A second
     * message written here would overwrite it with the words "Build failed",
     * which is precisely how the exact reason used to be lost.
     */
  }, [setLayout]);

  const cancelBuild = useCallback(() => buildService.cancel(), []);

  const cleanBuild = useCallback(async () => {
    const cleaned = await buildService.clean();
    setBottomPanelVisible(true);
    setBottomPanelView('output');
    setStatusMessage(cleaned.length === 0 ? 'Nothing to clean' : `Cleaned ${cleaned.length} file(s)`);
  }, []);

  const cleanAndBuild = useCallback(async () => {
    await cleanBuild();
    await buildProject();
  }, [cleanBuild, buildProject]);

  const rebuildProject = useCallback(() => buildProject({ force: true }), [buildProject]);

  const detectRecipes = useCallback(async () => {
    const detected = await buildService.detectTools(true);
    setTools(detected);
    setActiveRecipes(buildService.refreshRecipes());
  }, []);

  /**
   * Runs a project-wide content search over the open project.
   *
   * The scope is the folder open in the workspace — its files' *contents*. It is
   * not a search of project names, paths, or previously opened projects: the
   * project is chosen by opening it, and this searches inside it. `include`
   * narrows which files are read, and it is the one part of the scope that is
   * easy to be caught out by, which is why the panel reports the filter it
   * actually applied rather than leaving a `*.tex` default to be discovered as
   * "search finds nothing".
   */
  const runSearch = useCallback(async () => {
    const root = projectIndex.getProjectRoot();
    if (!root || !search.query.trim()) {
      setSearchState((previous) => ({ ...previous, results: [], error: root ? null : 'No folder is open' }));
      return;
    }

    setSearchState((previous) => ({ ...previous, running: true, error: null }));
    try {
      const result = await window.eukoliaApi.search({
        root,
        query: search.query,
        isRegex: search.isRegex,
        caseSensitive: search.caseSensitive,
        wholeWord: search.wholeWord,
        include: search.include || undefined,
        // The Explorer's excludes are part of what "the project" means, so a
        // search covers exactly the files the tree shows — plus `search.exclude`,
        // which VS Code folds in on top of them (`setting.searchExcludeDirectories`).
        excludeDirectories: setting.searchExcludeDirectories(),
        maxResults: 2000
      });
      setSearchState((previous) => ({
        ...previous,
        running: false,
        results: result.matches,
        truncated: result.truncated,
        durationMs: result.durationMs,
        filesScanned: result.filesScanned
      }));
    } catch (err) {
      setSearchState((previous) => ({
        ...previous,
        running: false,
        error: err instanceof Error ? err.message : String(err)
      }));
    }
  }, [search.query, search.isRegex, search.caseSensitive, search.wholeWord, search.include]);

  const replaceAll = useCallback(async () => {
    const root = projectIndex.getProjectRoot();
    if (!root || !search.query.trim()) return;
    const result = await window.eukoliaApi.replaceInFiles({
      root,
      query: search.query,
      isRegex: search.isRegex,
      caseSensitive: search.caseSensitive,
      wholeWord: search.wholeWord,
      include: search.include || undefined,
      replacement: search.replace
    });
    setStatusMessage(`Replaced ${result.replacements} occurrence(s) in ${result.filesChanged} file(s)`);
    await workspaceService.refreshTree();
    await runSearch();
  }, [search, runSearch]);

  const setSearch = useCallback((patch: Partial<SearchState>) => {
    setSearchState((previous) => ({ ...previous, ...patch }));
  }, []);

  const setCursor = useCallback((next: CursorState) => setCursorState(next), []);

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeSettingState(next);
    const resolved = themeManager.apply(next);
    setThemeState(resolved);
    setThemeAppearanceState(themeManager.getAppearance());
    settingsManager.setValue('general.theme', next);
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme(themeManager.cycle());
  }, [setTheme]);

  const setSetting = useCallback((key: string, value: unknown) => {
    settingsManager.setValue(key, value);
    if (key === 'general.theme') setTheme(value as ThemeSetting);
    // Visibility that has both a setting and a command must be driven by the
    // setting here, or changing it in the Settings UI would write the value and
    // leave the chrome exactly as it was.
    if (key === 'appearance.showStatusBar') setStatusBarVisible(Boolean(value));
    if (key === 'appearance.showActivityBar') setActivityBarVisible(Boolean(value));
  }, [setTheme]);

  const setPdfPath = useCallback((path: string | null) => {
    setPdf((previous) => ({ ...previous, path, error: null, loading: path !== null }));
  }, []);

  const setPdfState = useCallback((patch: Partial<PdfState>) => {
    // `patchPdfState` owns the "the page readout never points past the end of the
    // document" invariant, so every caller gets it rather than just the one that
    // happened to be found.
    setPdf((previous) => patchPdfState(previous, patch));
  }, []);

  /**
   * Asks the viewer to look at the file again — or to re-open it outright.
   *
   * Two tokens rather than one because the two answers differ: a build finished
   * and the file *may* have changed (check the modification time), or the reader
   * pressed Reload Document and wants the bytes on disk whatever it says (re-open
   * now). Both leave the page and the scroll position alone: the viewer restores
   * them from the remembered per-document state, exactly as it does for the
   * automatic reload light-pdf performs when a file changes under it.
   */
  const reloadPdf = useCallback((force = false) => {
    setPdf((previous) =>
      force
        ? { ...previous, forceToken: previous.forceToken + 1 }
        : { ...previous, checkToken: previous.checkToken + 1 }
    );
  }, []);

  const setPdfVisible = useCallback((visible: boolean) => {
    setPdf((previous) => ({ ...previous, visible }));
    setLayoutState((previous): LayoutMode => {
      if (!visible) {
        // Collapsing the PDF leaves Focus Mode; any other layout keeps its shape
        // so restoring the pane brings the same layout back.
        return previous === 'pdf' ? 'editor' : previous;
      }
      return previous === 'editor' ? 'split' : previous;
    });
  }, []);

  const revealInEditor = useCallback((line: number, column = 1) => {
    editorHandleRef.current?.revealPosition(line, column);
  }, []);

  const goToSource = useCallback(async (file: string, line: number, column = 1) => {
    await workspaceService.openFile(file, { line, column });
    // Wait for the editor to swap models before revealing.
    requestAnimationFrame(() => editorHandleRef.current?.revealPosition(line, column));
  }, []);

  // --------------------------------------------------------- command context

  useEffect(() => {
    const context: Partial<CommandContext> = {
      editorMode,
      hasDocument: workspace.documents.length > 0,
      hasWorkspace: workspace.workspacePath !== null,
      hasPdf: pdf.path !== null,
      isBuilding: build.status === 'running',
      layout
    };
    commandRegistry.setContext(context);
  }, [editorMode, workspace.documents.length, workspace.workspacePath, pdf.path, build.status, layout]);

  // --------------------------------------------------------- session capture

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void window.eukoliaApi.setState({
        workspacePath: workspace.workspacePath,
        openFiles: workspace.documents.filter((entry) => !entry.doc.uri.startsWith('untitled:')).map((entry) => entry.doc.uri),
        activeFile: workspace.activeUri,
        // Remembered so the next launch does not re-derive it: detection reads the
        // head of every `.tex` file in the project, and the answer is the same
        // until someone edits a magic comment.
        rootFile: rootFileDoc,
        layout,
        editorMode,
        sidebarVisible,
        pdfVisible: pdf.visible,
        pdfPath: pdf.path,
        pdfPage: pdf.page,
        pdfZoom: pdf.zoom,
        theme: themeSetting
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [ready, workspace, rootFileDoc, layout, editorMode, sidebarVisible, pdf.visible, pdf.path, pdf.page, pdf.zoom, themeSetting]);

  const activeDocument = useMemo(
    () => workspace.documents.find((entry) => entry.doc.uri === workspace.activeUri) ?? workspace.documents[0] ?? null,
    [workspace]
  );

  const value = useMemo<AppStateValue>(
    () => ({
      ready,
      bootError,
      workspace,
      documents: workspace.documents,
      activeDocument,
      activeDoc: activeDocument?.doc ?? null,
      fileTree,
      outline,
      recentWorkspaces,
      diagnostics,
      build,
      layout,
      editorMode,
      sidebarView,
      sidebarVisible,
      bottomPanelVisible,
      bottomPanelView,
      tabBarVisible,
      statusBarVisible,
      activityBarVisible,
      terminalVisible,
      pdf,
      cursor,
      theme,
      themeAppearance,
      themeSetting,
      search,
      statusMessage,
      paletteOpen,
      quickOpenOpen,
      settingsOpen,
      settingsSection,
      shortcutsOpen,
      aboutOpen,
      buildPickerOpen,
      snippetsOpen,
      snippetFocusId,
      activeRecipes,
      activeRecipeName,
      tools,
      openFolder,
      openFile,
      closeDocument,
      setActiveDocument,
      save,
      saveAs,
      saveAll,
      runAutoSave,
      newFile,
      reopenClosedEditor,
      goToRootDocument,
      setLayout,
      setEditorMode,
      setSidebarView,
      toggleSidebar,
      showSidebar,
      toggleBottomPanel,
      setBottomPanelView,
      toggleTabBar,
      toggleStatusBar,
      toggleActivityBar,
      togglePanelBar,
      toggleFocusMode,
      toggleTerminal,
      setTerminalVisible: setTerminalVisibleValue,
      buildProject,
      cancelBuild,
      cleanBuild,
      cleanAndBuild,
      rebuildProject,
      detectRecipes,
      setPdfVisible,
      setPdfPath,
      setPdfState,
      reloadPdf,
      runSearch,
      setSearch,
      replaceAll,
      setCursor,
      setTheme,
      cycleTheme,
      setSetting,
      setStatusMessage,
      setPaletteOpen,
      setQuickOpenOpen,
      setSettingsOpen,
      toggleSettings,
      openSettingsSection,
      setShortcutsOpen,
      setAboutOpen,
      setBuildPickerOpen,
      setSnippetsOpen,
      registerSnippetsCloseHandler,
      toggleSnippets,
      openSnippetInManager,
      revealInEditor,
      goToSource,
      editorHandleRef
    }),
    [
      ready,
      bootError,
      workspace,
      activeDocument,
      fileTree,
      outline,
      recentWorkspaces,
      diagnostics,
      build,
      layout,
      editorMode,
      sidebarView,
      sidebarVisible,
      bottomPanelVisible,
      bottomPanelView,
      tabBarVisible,
      statusBarVisible,
      // Without this the memo never recomputed when the activity bar was
      // toggled: the value object carried the flag but the dependency array did
      // not, so the rendered bar kept the initial `true` and the toggle did
      // nothing. A missing dependency is invisible to the typechecker, which is
      // why the end-to-end probe asserts the bar actually leaves the DOM.
      activityBarVisible,
      pdf,
      cursor,
      theme,
      themeAppearance,
      themeSetting,
      search,
      statusMessage,
      paletteOpen,
      quickOpenOpen,
      settingsOpen,
      settingsSection,
      shortcutsOpen,
      aboutOpen,
      buildPickerOpen,
      snippetsOpen,
      snippetFocusId,
      activeRecipes,
      activeRecipeName,
      tools,
      openFolder,
      openFile,
      closeDocument,
      setActiveDocument,
      save,
      saveAs,
      saveAll,
      runAutoSave,
      newFile,
      reopenClosedEditor,
      goToRootDocument,
      setLayout,
      setEditorMode,
      setSidebarView,
      toggleSidebar,
      showSidebar,
      toggleBottomPanel,
      togglePanelBar,
      toggleFocusMode,
      buildProject,
      cancelBuild,
      cleanBuild,
      cleanAndBuild,
      rebuildProject,
      detectRecipes,
      setPdfVisible,
      setPdfPath,
      setPdfState,
      reloadPdf,
      runSearch,
      setSearch,
      replaceAll,
      setCursor,
      setTheme,
      cycleTheme,
      setSetting,
      setSnippetsOpen,
      registerSnippetsCloseHandler,
      toggleSnippets,
      openSnippetInManager,
      revealInEditor,
      goToSource
    ]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
};

/** Convenience: the snippet engine, created lazily. */
export function snippetEngine() {
  return getSnippetEngine();
}
