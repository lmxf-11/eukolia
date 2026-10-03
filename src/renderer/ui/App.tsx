/** * Eukolia — application shell. * * Owns the layout, the global keyboard dispatch, the command definitions, the * overlays (palette, quick open, settings, shortcuts, build picker) and the * wiring between the code editor, the visual editor and the PDF viewer. * * Layouts follow Instructions.md §42; the PDF pane is collapsible and restores * its page, scroll position, zoom and search state (§43). */ import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppStateProvider, useAppState } from './state';
import { LibraryHome, ProjectLibraryDialog, showProjectLibrary } from './components/ProjectLibrary';
import { sidebarShown, sidebarChromeVisible } from './sidebarRegion';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TopLeftMenuButton } from './components/TopLeftMenuButton';
import { BottomPanel } from './components/BottomPanel';
import { StatusBar } from './components/StatusBar';
import { ActivityBar } from './components/ActivityBar';
import { matchViewerAccelerator } from '../pdf/lightpdf-keyboard';
import { SplitPane } from './components/SplitPane';
import { FocusPdfFloat } from './components/FocusPdfFloat';
import { focusFloatWidth, rememberFocusFloatWidth, useFocusPdfFloat } from './focusFloat';
import { Modal } from './components/Modal';
import { CircleAlert, Search, X } from './components/icons';
/**
 * Everything behind an interaction is loaded on demand — the editor, the PDF
 * viewer, Settings, the snippet library, the terminal, the palette. See
 * `lazySurfaces.tsx` for why that split is where it is; the shell itself
 * (tab strip, sidebar, status bar) stays a direct import because it *is* the
 * first frame.
 */
import {
    Deferred,
    LazyCommandPalette,
    LazyPdfPane,
    LazyQuickOpen,
    LazySettingsView,
    LazySnippetManager,
    LazyTabSwitcher,
    LazyVisualEditor
} from './lazySurfaces';
import type { PdfViewerHandle, PdfZoomMode } from '../pdf/PdfViewer';
import { commandRegistry } from '../core/commands';
import { SETTING_CATEGORIES, SHORTCUTS_SECTION, settingsManager, setting } from '../core/settings';
import { formattingEngine } from '../aligner/texAligner';
import { projectIndex } from '../document/projectIndex';
import { globalEvents } from '../core/events';
import { LIGHTPDF_CMD } from '../pdf/lightpdf-commands';
import { setEditorBridge } from '../services/vscodeHost';
import { startupMark } from '../core/startupProbe';
import { dismissBootScreen } from '../core/bootScreen';
/** Overlays that must work even while a text field has focus. */ const GLOBAL_OVERLAY_COMMANDS = new Set(['workbench.commandPalette',
    'workbench.quickOpen', 'editor.toggleSnippets']);
// ---------------------------------------------------------------------------
// Escape from the settings pane
// ---------------------------------------------------------------------------
/**
 * The overlays that sit *above* the settings pane.
 *
 * While any of them is open, Escape belongs to it: the palette, quick open and
 * the dialogs all close themselves on that key, and a second handler acting on
 * the same press would dismiss the pane behind them as well, which reads as the
 * dialog having failed to close.
 */
export function isOverlayAboveSettings(state: {
    paletteOpen: boolean;
    quickOpenOpen: boolean;
    shortcutsOpen: boolean;
    aboutOpen: boolean;
    buildPickerOpen: boolean;
    snippetsOpen: boolean;
}): boolean {
    return (state.paletteOpen ||
        state.quickOpenOpen ||
        state.shortcutsOpen ||
        state.aboutOpen ||
        state.buildPickerOpen ||
        state.snippetsOpen);
}
/**
 * What Escape does inside the settings pane.
 *
 * Two steps, innermost first: leave the section being shown, then close the pane.
 * The keyboard-shortcut editor replaces the pane's whole body, so it has
 * somewhere of its own to go, and Escape from the category list leaves Settings
 * entirely.
 *
 * The snippet library is no longer one of these: it is a window of its own, above
 * the pane rather than inside it, and it closes itself.
 *
 * Extracted so the rule can be tested without a DOM: it is the part that is easy
 * to get wrong, and getting it wrong is what trapped the user in the first place.
 */
export type EscapeAction = 'leave-section' | 'close-settings' | 'none';
export function escapeFromSettings(state: { settingsOpen: boolean; settingsSection: string; paletteOpen: boolean; quickOpenOpen: boolean; shortcutsOpen: boolean; aboutOpen: boolean; buildPickerOpen: boolean; snippetsOpen: boolean }): EscapeAction {
    if (!state.settingsOpen)
        return 'none';
    if (isOverlayAboveSettings(state))
        return 'none';
    if (state.settingsSection === SHORTCUTS_SECTION)
        return 'leave-section';
    return 'close-settings';
}
// ---------------------------------------------------------------------------
// Commands// ---------------------------------------------------------------------------
function useApplicationCommands(): void {
    const state = useAppState();
    useEffect(() => {
        const disposers = commandRegistry.registerAll([
            { id: 'file.newProject', title: 'New Project…', category: 'File', keybinding: 'Ctrl+Alt+N', handler: () => { showProjectLibrary('create'); } },
            { id: 'file.projectLibrary', title: 'Open Project Library', category: 'File', handler: () => { showProjectLibrary(); } },
            {
                id: 'file.openFile', title: 'Open File…', category: 'File', keybinding: 'Ctrl+O', handler: () => state.openFile()
            },
            {
                id: 'file.openFolder', title: 'Open Folder…', category: 'File', keybinding: 'Ctrl+K Ctrl+O', handler: () => state.openFolder()
            },
            {
                id: 'file.newFile', title: 'New LaTeX File', category: 'File', keybinding: 'Ctrl+N', handler: () => state.newFile()
            },
            {
                id: 'file.save', title: 'Save', category: 'File', keybinding: 'Ctrl+S', handler: () => state.save()
            },
            {
                id: 'file.saveAs', title: 'Save As…', category: 'File', keybinding: 'Ctrl+Shift+S', handler: () => state.saveAs()
            },
            {
                id: 'file.saveAll', title: 'Save All', category: 'File', keybinding: 'Ctrl+Alt+S', handler: () => state.saveAll()
            },
            {
                id: 'file.closeEditor', title: 'Close Editor', category: 'File', keybinding: 'Ctrl+W',
                when: (context) => context.hasDocument, handler: () => {
                    const uri = state.workspace.activeUri;
                    if (uri)
                        void state.closeDocument(uri);
                }
            },
            {
                id: 'workbench.action.reopenClosedEditor', title: 'Reopen Closed Editor', category: 'File',
                keybinding: 'Ctrl+Shift+T', handler: () => void state.reopenClosedEditor()
            },
            {
                id: 'file.revealInExplorer', title: 'Reveal Active File in Explorer', category: 'File',
                when: (context) => context.hasDocument, handler: () => {
                    if (state.activeDoc)
                        void window.eukoliaApi.revealInExplorer(state.activeDoc.uri);
                }
            },
            {
                id: 'file.copyPath', title: 'Copy Path of Active File', category: 'File', when: (context) => context.hasDocument,
                handler: async () => {
                    if (!state.activeDoc)
                        return;
                    await navigator.clipboard.writeText(state.activeDoc.uri);
                    state.setStatusMessage('Path copied');
                }
            }, // ---------------------------------------------------------- Workspace
            {
                id: 'workbench.commandPalette', title: 'Show All Commands', category: 'View', keybinding: 'Ctrl+Shift+P',
                handler: () => state.setPaletteOpen(true)
            },
            {
                id: 'workbench.quickOpen', title: 'Go to File…', category: 'View', keybinding: 'Ctrl+P', handler: () => state.setQuickOpenOpen(true)
            },
            {
                id: 'workbench.settings', title: 'Open Settings', category: 'Preferences', keybinding: 'Ctrl+,',
                handler: () => {
                    if (window.eukoliaApi?.openSettingsWindow) {
                        void window.eukoliaApi.openSettingsWindow();
                    } else {
                        state.toggleSettings();
                    }
                }
            },
            {
                id: 'workbench.snippets', title: 'Manage Snippets', category: 'Preferences', keybinding: 'Ctrl+Alt+L',
                handler: () => {
                    if (window.eukoliaApi?.openSnippetsWindow) {
                        void window.eukoliaApi.openSnippetsWindow();
                    } else {
                        state.toggleSnippets();
                    }
                }
            },
            {
                id: 'workbench.userDirectory', title: 'Open User Settings Folder', category: 'Preferences',
                // Where `settings.json` and any `*.hsnips` the user writes live —
                // `%APPDATA%\Eukolia\User` on Windows. Opening the folder is also how a
                // user adds snippets, so one command serves both.
                handler: () => {
                    void window.eukoliaApi.openUserDirectory().then(path => window.eukoliaApi.log('info', `[eukolia] user folder: ${path}`)).catch(error => console.error('[eukolia] could not open the user folder', error));
                }
            },
            {
                id: 'workbench.advancedSettings', title: 'Open Advanced Settings (JSON)', category: 'Preferences',
                keybinding: 'Ctrl+Alt+,', // The settings UI covers what the schema names; this opens the file where
                // everything else lives — including `keybindings.<command id>` for a
                // command with no dedicated setting.
                handler: () => {
                    void window.eukoliaApi.openAdvancedSettings('user').then(path => window.eukoliaApi.log('info', `[eukolia] advanced settings: ${path}`)).catch(error => console.error('[eukolia] could not open the advanced settings file', error));
                }
            },
            {
                id: 'workbench.shortcuts', title: 'Open Keyboard Shortcuts', category: 'Preferences', keybinding: 'Ctrl+K Ctrl+S',
                handler: () => state.setShortcutsOpen(true)
            },
            {
                id: 'workbench.about', title: 'About Eukolia', category: 'Help', handler: () => state.setAboutOpen(true)
            },
            {
                id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', keybinding: 'Ctrl+B', handler: () => state.toggleSidebar()
            },
            {
                id: 'view.explorer', title: 'Show Explorer', category: 'View', keybinding: 'Ctrl+Shift+E', handler: () => state.setSidebarView('explorer')
            },
            {
                id: 'view.outline', title: 'Show Outline', category: 'View', keybinding: 'Ctrl+Shift+O', handler: () => state.setSidebarView('outline')
            },
            {
                id: 'view.search', title: 'Show Search', category: 'View', keybinding: 'Ctrl+Shift+F', handler: () => state.setSidebarView('search')
            },
            {
                id: 'view.symbols', title: 'Show Project Symbols', category: 'View', handler: () => state.setSidebarView('symbols')
            },
            {
                id: 'view.snippets', title: 'Show Snippets', category: 'View', handler: () => state.setSidebarView('snippets')
            },
            {
                id: 'view.togglePanel', title: 'Toggle Bottom Panel', category: 'View', keybinding: 'Ctrl+J', handler: () => state.toggleBottomPanel()
            }, // Chrome toggles. Each has a settings key (`keybindings.*`) so the shortcut
            // is rebindable from the Settings UI without touching code.
            {
                id: 'view.toggleTabBar', title: 'Toggle Tab Bar', category: 'View', keybinding: 'Ctrl+Alt+T', handler: () => state.toggleTabBar()
            },
            {
                id: 'view.toggleStatusBar', title: 'Toggle Status Bar', category: 'View', keybinding: 'Ctrl+Alt+B', handler: () => state.toggleStatusBar()
            },
            {
                // The activity bar is the only way to switch sidebar views, so
                // hiding it needs a command to bring it back as well as the
                // `appearance.showActivityBar` setting that persists the choice.
                id: 'view.toggleActivityBar', title: 'Toggle Activity Bar', category: 'View', keybinding: 'Ctrl+Alt+A', handler: () => state.toggleActivityBar()
            },
            {
                id: 'view.menu', title: 'Show Menu', category: 'View', handler: () => state.setSidebarView('menu')
            },
            {
                id: 'view.togglePanelBar', title: 'Toggle Panel Bar', category: 'View',
                handler: () => state.togglePanelBar()
            },
            {
                id: 'view.toggleTerminal', title: 'Toggle Terminal', category: 'View', keybinding: 'Ctrl+`',
                // The terminal is a view of the bottom panel, so this reveals the
                // panel on that view and hides the panel again only while the
                // terminal is the view showing; from Problems, Output, Log or
                // Search it switches to the terminal instead of closing the panel.
                handler: () => {
                    if (state.bottomPanelVisible && state.bottomPanelView === 'terminal')
                        state.toggleBottomPanel();
                    else
                        state.toggleBottomPanel('terminal');
                }
            },
            {
                id: 'view.problems', title: 'Show Problems', category: 'View', keybinding: 'Ctrl+Shift+M', handler: () => state.toggleBottomPanel('problems')
            },
            {
                id: 'view.output', title: 'Show Output', category: 'View', handler: () => state.toggleBottomPanel('output')
            },
            {
                /**
                 * Focus Mode, as a toggle rather than a destination.
                 *
                 * A *control* for Focus Mode has to be able to leave it: the tab
                 * bar's button is pressed from this state and must come off when
                 * pressed again. So one command does both — `Ctrl+Alt+1` enters
                 * Focus Mode from any layout and leaves it for the split layout
                 * from Focus Mode, which is one key and one menu entry for the
                 * thing a user actually reaches for.
                 *
                 * It used to be two commands sharing the key: a `view.toggleFocusMode`
                 * registered beside this one. That does not work, and the
                 * end-to-end probe caught it — the registry resolves a binding to
                 * the *first* command holding it, so the destination won and the
                 * toggle was unreachable from the keyboard. The other layouts
                 * (`Ctrl+Alt+2`…`6`) are still destinations, and reaching them is
                 * how a user leaves Focus Mode for a specific one.
                 */
                id: 'view.focusMode', title: 'Toggle Focus Mode', category: 'View', keybinding: 'Ctrl+Alt+1',
                handler: () => state.toggleFocusMode()
            },
            {
                id: 'view.sourcePdf', title: 'Source + PDF', category: 'View', keybinding: 'Ctrl+Alt+2', handler: () => state.setLayout('split')
            },
            {
                id: 'view.visualPdf', title: 'Visual + PDF', category: 'View', keybinding: 'Ctrl+Alt+3', handler: () => state.setLayout('visual-pdf')
            },
            {
                id: 'view.sourceVisual', title: 'Source + Visual', category: 'View', keybinding: 'Ctrl+Alt+4', handler: () => state.setLayout('source-visual')
            },
            {
                id: 'view.pdfOnly', title: 'PDF Mode', category: 'View', keybinding: 'Ctrl+Alt+5', handler: () => state.setLayout('pdf')
            },
            {
                id: 'view.threeWay', title: 'Code + Visual + PDF', category: 'View', keybinding: 'Ctrl+Alt+6', handler: () => state.setLayout('all')
            },
            {
                /**
                 * Focus Mode's floating viewer (`focusFloat.ts`). The gesture is
                 * holding Alt; this is the same overlay reached from the keyboard,
                 * which is what §48's "nearly every significant action should be
                 * available from the keyboard" asks for.
                 *
                 * Dispatched through `globalEvents` rather than handled here
                 * because the state it toggles lives in `AppShell`, which is the
                 * component that can render the overlay — the same channel the
                 * `pdf.*` commands below use to reach the pane.
                 */
                id: 'pdf.toggleFocusFloat', title: 'PDF: Float the Viewer in Focus Mode', category: 'PDF',
                when: (context) => context.layout === 'editor' && context.hasPdf,
                handler: () => globalEvents.emit('pdf:focusFloat', null)
            },
            {
                id: 'view.toggleTheme', title: 'Cycle Theme', category: 'Appearance', // `Ctrl+Alt+T` belongs to the tab bar; this cycles through every theme so
                // the ones that are not light or dark are reachable from the keyboard.
                keybinding: 'Ctrl+Alt+Y', handler: () => state.cycleTheme()
            }, // ---------------------------------------------------------------- Edit
            //
            // VS Code's Edit and Selection menus. Undo/redo go through the document
            // model, which owns history for both editors (Instructions.md §28), so they
            // work whichever surface is showing. Cut/copy/paste and select-all are
            // delegated to the focused surface, which is what lets one menu entry serve
            // Monaco, CodeMirror and the PDF viewer's text layer alike.
            {
                id: 'edit.undo', title: 'Undo', category: 'Edit', keybinding: 'Ctrl+Z', handler: () => {
                    state.activeDoc?.undo();
                }
            },
            {
                id: 'edit.redo', title: 'Redo', category: 'Edit', keybinding: 'Ctrl+Y', secondaryKeybindings: ['Ctrl+Shift+Z'],
                handler: () => {
                    state.activeDoc?.redo();
                }
            },
            {
                id: 'edit.cut', title: 'Cut', category: 'Edit', keybinding: 'Ctrl+X', handler: () => {
                    document.execCommand('cut');
                }
            },
            {
                id: 'edit.copy', title: 'Copy', category: 'Edit', keybinding: 'Ctrl+C', handler: () => {
                    document.execCommand('copy');
                }
            },
            {
                id: 'edit.paste', title: 'Paste', category: 'Edit', keybinding: 'Ctrl+V',
                handler: () => {
                    document.execCommand('paste');
                }
            },
            {
                id: 'edit.formatDocument', title: 'Format Document (Align Ampersands)', category: 'Edit',
                keybinding: 'Ctrl+Shift+I', // Reuses the aligner's own command rather than duplicating the call, so
                // the menu entry and the palette entry cannot drift apart.
                handler: () => commandRegistry.execute('editor.formatAmpersands')
            },
            {
                id: 'edit.selectAll', title: 'Select All', category: 'Selection', keybinding: 'Ctrl+A',
                handler: () => {
                    document.execCommand('selectAll');
                }
            }, // ----------------------------------------------------------- Terminal
            {
                id: 'terminal.new', title: 'New Terminal', category: 'Terminal', keybinding: 'Ctrl+Shift+`', handler: () => state.setTerminalVisible(true)
            },
            {
                id: 'terminal.kill', title: 'Kill Terminal', category: 'Terminal', handler: () => state.setTerminalVisible(false)
            }, // ------------------------------------------------------------- Editor
            {
                id: 'editor.codeMode', title: 'Code Mode', category: 'Editor', keybinding: 'Ctrl+1', handler: () => state.setEditorMode('code')
            },
            {
                id: 'editor.visualMode', title: 'Visual Mode', category: 'Editor', keybinding: 'Ctrl+2', handler: () => state.setEditorMode('visual')
            },
            {
                id: 'editor.toggleMode', title: 'Toggle Code / Visual Mode', category: 'Editor',
                keybinding: 'Ctrl+Shift+V', handler: () => state.setEditorMode(state.editorMode === 'code' ? 'visual' : 'code')
            },
            {
                id: 'editor.formatAmpersands', title: 'Format: Align TeX Ampersands', category: 'Editor',
                keybinding: 'Ctrl+Alt+F', when: (context) => context.hasDocument, handler: () => {
                    const doc = state.activeDoc;
                    if (!doc)
                        return;
                    const formatted = formattingEngine.alignDocument(doc.getText());
                    if (formatted !== doc.getText()) {
                        doc.setText(formatted, 'format');
                        state.setStatusMessage('Aligned ampersands');
                    }
                    else {
                        state.setStatusMessage('Nothing to align');
                    }
                }
            },
            {
                id: 'editor.alignSelection', title: 'Format: Align Ampersands in Selection', category: 'Editor',
                when: (context) => context.hasDocument, handler: () => state.editorHandleRef.current?.alignAmpersands('selection')
            }, // -------------------------------------------------------------- LaTeX
            {
                id: 'latex.build', title: 'Build Project', category: 'LaTeX', keybinding: 'Ctrl+B', handler: () => state.buildProject()
            },
            {
                id: 'latex.buildActiveFile', title: 'Build the Active File', category: 'LaTeX',
                keybinding: 'Ctrl+Alt+Shift+B', when: (context) => context.hasDocument, handler: () => {
                    const uri = state.activeDoc?.uri;
                    if (!uri || uri.startsWith('untitled:')) {
                        state.setStatusMessage('Save the file before building it on its own');
                        return;
                    }
                    void state.buildProject({
                        rootFile: uri
                    });
                }
            },
            {
                id: 'latex.buildWithRecipe', title: 'Build with Recipe…', category: 'LaTeX', keybinding: 'Ctrl+Shift+B',
                handler: () => state.setBuildPickerOpen(true)
            },
            {
                id: 'latex.buildAndView', title: 'Build and View', category: 'LaTeX', keybinding: 'Ctrl+Alt+B',
                handler: async () => {
                    await state.buildProject();
                    state.setLayout(state.layout === 'editor' ? 'split' : state.layout);
                }
            },
            {
                // §32 names Rebuild beside Build, and they differ: Build lets
                // latexmk decide which rules are out of date, Rebuild forces all
                // of them. Without the distinction the command would be a second
                // name for one action, which §46 rules out.
                id: 'latex.rebuild', title: 'Rebuild (force every rule)', category: 'LaTeX',
                keybinding: 'Ctrl+Alt+Shift+R',
                when: (context) => context.hasWorkspace || context.hasDocument,
                handler: () => state.rebuildProject()
            },
            {
                id: 'latex.stopBuild', title: 'Stop Compilation', category: 'LaTeX', when: (c) => c.isBuilding, handler: () => state.cancelBuild()
            },
            {
                id: 'latex.clean', title: 'Clean Auxiliary Files', category: 'LaTeX', handler: () => state.cleanBuild()
            },
            {
                id: 'latex.cleanAndBuild', title: 'Clean and Build', category: 'LaTeX', handler: () => state.cleanAndBuild()
            },
            {
                id: 'latex.detectTools', title: 'Detect TeX Distribution', category: 'LaTeX', handler: async () => {
                    await state.detectRecipes();
                    state.setStatusMessage('TeX tool detection finished');
                }
            },
            {
                id: 'latex.forwardSearch', title: 'SyncTeX: Jump from Source to PDF', category: 'LaTeX',
                keybinding: 'Ctrl+Alt+J', when: (context) => context.hasDocument && context.hasPdf, handler: () => globalEvents.emit('synctex:forward', null)
            },
            {
                id: 'navigate.goToRootDocument', title: 'Go to Root Document', category: 'Navigation',
                keybinding: 'Ctrl+Alt+R', handler: () => void state.goToRootDocument()
            }, // ---------------------------------------------------------------- PDF
            {
                id: 'pdf.toggleViewer', title: 'Toggle PDF Viewer', category: 'PDF', keybinding: 'Ctrl+Alt+V', handler: () => state.setPdfVisible(!state.pdf.visible)
            },
            {
                id: 'pdf.fitWidth', title: 'PDF: Fit Width', category: 'PDF', when: (context) => context.hasPdf,
                handler: () => state.setPdfState({
                    zoomMode: 'page-width'
                })
            },
            {
                id: 'pdf.fitPage', title: 'PDF: Fit Page', category: 'PDF', when: (context) => context.hasPdf,
                handler: () => state.setPdfState({
                    zoomMode: 'page-fit'
                })
            },
            {
                id: 'pdf.actualSize', title: 'PDF: Actual Size', category: 'PDF', when: (context) => context.hasPdf,
                handler: () => state.setPdfState({
                    zoomMode: 'actual'
                })
            },
            {
                id: 'pdf.zoomIn', title: 'PDF: Zoom In', category: 'PDF', when: (context) => context.hasPdf,
                handler: () => state.setPdfState({
                    zoom: Math.min(8, state.pdf.zoom * 1.15), zoomMode: 'custom'
                })
            },
            {
                id: 'pdf.zoomOut', title: 'PDF: Zoom Out', category: 'PDF', when: (context) => context.hasPdf,
                handler: () => state.setPdfState({
                    zoom: Math.max(0.1, state.pdf.zoom / 1.15), zoomMode: 'custom'
                })
            },
            {
                id: 'pdf.reload', title: 'PDF: Reload', category: 'PDF', when: (context) => context.hasPdf,
                handler: () => {
                    const path = state.pdf.path;
                    if (!path)
                        return;
                    state.setPdfPath(null);
                    setTimeout(() => state.setPdfPath(path), 50);
                }
            },
            // The rest of light-pdf's document commands, dispatched to the pane's
            // own command table (`lightpdf-keyboard.ts`) so the palette, the
            // toolbar and the keyboard stay one implementation. light-pdf's
            // palette reaches every command the same way
            // (`CommandPaletteCollect.cpp` enumerates `gCommandDescriptions`).
            ...([
                ['pdf.toggleToolbar', 'PDF: Toggle Toolbar', LIGHTPDF_CMD.CmdToggleToolbar],
                ['pdf.toggleBookmarks', 'PDF: Toggle Bookmarks', LIGHTPDF_CMD.CmdToggleBookmarks],
                ['pdf.toggleLinks', 'PDF: Toggle Show Links', LIGHTPDF_CMD.CmdToggleLinks],
                ['pdf.copyFilePath', 'PDF: Copy File Path', LIGHTPDF_CMD.CmdCopyFilePath],
                ['pdf.properties', 'PDF: Document Properties', LIGHTPDF_CMD.CmdProperties],
                ['pdf.reloadDocument', 'PDF: Reload Document', LIGHTPDF_CMD.CmdReloadDocument],
                ['pdf.singlePageView', 'PDF: Single Page View', LIGHTPDF_CMD.CmdSinglePageView],
                ['pdf.facingView', 'PDF: Facing View', LIGHTPDF_CMD.CmdFacingView],
                ['pdf.bookView', 'PDF: Book View', LIGHTPDF_CMD.CmdBookView],
                ['pdf.shrinkToFit', 'PDF: Zoom Shrink To Fit', LIGHTPDF_CMD.CmdZoomShrinkToFit],
                ['pdf.fitByOrientation', 'PDF: Zoom Fit by Orientation', LIGHTPDF_CMD.CmdZoomFitByOrientation],
                ['pdf.customZoom', 'PDF: Custom Zoom...', LIGHTPDF_CMD.CmdZoomCustom],
                ['pdf.findNextSelection', 'PDF: Find Next Selection', LIGHTPDF_CMD.CmdFindNextSel],
                ['pdf.findPrevSelection', 'PDF: Find Previous Selection', LIGHTPDF_CMD.CmdFindPrevSel],
                // `CmdStartAutoScroll` (427, `StartAutoScrollAtCursor`),
                // `CmdToggleCursorPosition` (365) and `CmdChangeScrollbar` (232,
                // `Dialog_ChangeScrollbar`) have no default accelerator in
                // light-pdf either: the palette is their surface.
                ['pdf.startAutoScroll', 'PDF: Start Auto-Scroll', LIGHTPDF_CMD.CmdStartAutoScroll],
                ['pdf.toggleCursorPosition', 'PDF: Toggle Cursor Position', LIGHTPDF_CMD.CmdToggleCursorPosition],
                ['pdf.changeScrollbar', 'PDF: Change Scrollbar...', LIGHTPDF_CMD.CmdChangeScrollbar],
                ['pdf.findWholeWord', 'PDF: Find — Toggle Match Whole Word', LIGHTPDF_CMD.CmdFindToggleMatchWholeWord]
            ] as const).map(([id, title, command]) => ({
                id, title, category: 'PDF',
                when: (context: { hasPdf: boolean }) => context.hasPdf,
                handler: () => globalEvents.emit('pdf:command', command)
            })), // --------------------------------------------------------------- Help
            {
                id: 'help.documentation', title: 'Eukolia Documentation', category: 'Help', handler: () => state.setAboutOpen(true)
            },
            {
                id: 'help.versions', title: 'Show Version Information', category: 'Help', handler: async () => {
                    const versions = await window.eukoliaApi.getVersions();
                    state.setStatusMessage(`Eukolia ${versions.app} · Electron ${versions.electron} · Node ${versions.node}`);
                }
            }
        ]);
        return () => disposers();
    }, [state]);
}
// ---------------------------------------------------------------------------
// Shell// ---------------------------------------------------------------------------
/**
 * The sidebar's width limits, named because three places have to agree on them:
 * the region's own `min`/`max` style, the pointer drag, and the keyboard resize
 * the handle offers. They used to be two literals inside `onMove` and two more
 * inside the region's style, which is four chances to disagree.
 */
export const SIDEBAR_MIN_WIDTH = 140;
export const SIDEBAR_MAX_WIDTH = 700;

/** Clamps a sidebar width into the usable range. */
export function clampSidebarWidth(value: number): number {
    if (!Number.isFinite(value)) return SIDEBAR_MIN_WIDTH;
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, value));
}

/**
 * The shell's layout, separated from the provider so it can be rendered against
 * a supplied state.
 *
 * Exported because the two sidebar conditions below — which element is the
 * sidebar, and whether the activity bar comes with it — are decisions about the
 * shell that no other test can reach: the rule they call is tested on its own in
 * `sidebar-region.test.ts`, but nothing there can catch the shell *forgetting to
 * use it*, which is exactly how the strip was left behind after a collapse.
 */
/**
 * How many times the shell has rendered.
 *
 * Recorded because "the shell rendered" and "the shell re-rendered" are the only
 * two things a component can say about itself, and a milestone list that shows
 * the same name twice with two seconds between them reads as a stall when it is
 * only a second pass. A counter makes the difference visible in the profile —
 * `appearance.showActivityBar` arriving from the settings file is one re-render,
 * and without the count it looked like the shell had taken two seconds to appear.
 */
let shellRenderCount = 0;

export const AppShell: React.FC = () => {
    const state = useAppState();
    shellRenderCount += 1;
    startupMark(state.ready ? `shell:render#${shellRenderCount}` : `shell:boot-render#${shellRenderCount}`);
    const [pdfZoom, setPdfZoom] = useState(1);
    const [pdfZoomMode, setPdfZoomMode] = useState<PdfZoomMode>('page-width');
    const pdfHandleRef = useRef<PdfViewerHandle | null>(null);
    const [sidebarWidth, setSidebarWidth] = useState(() => setting.num('appearance.sidebarWidth'));

    /**
     * Whether collapsing the sidebar takes the activity bar with it.
     *
     * Read through the settings manager and mirrored into a revision counter so
     * flipping it in Settings takes effect at once — the sidebar is on screen
     * beside the pane while it is being changed, and a control whose effect only
     * appears after a restart reads as one that does nothing.
     */
    const [settingsRevision, setSettingsRevision] = useState(0);
    useEffect(() => settingsManager.on('change', () => setSettingsRevision((value) => value + 1)), []);
    const collapseWithSidebar = useMemo(
      () => setting.bool('appearance.collapseActivityBarWithSidebar'),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the revision is the trigger
      [settingsRevision]
    );
    const panelBarShown = sidebarChromeVisible({
      sidebarRequested: state.sidebarVisible,
      activityBarEnabled: state.activityBarVisible,
      collapseWithSidebar
    });

    // ------------------------------------------------- Focus Mode's PDF overlay
    //
    // Focus Mode is the editor alone (`Instructions.md` §42), so the viewer
    // cannot be docked there. Holding Alt floats it over the window's right-hand
    // side at a width of its own (`focusFloat.ts` owns the state machine and the
    // reasons behind each rule); this is the wiring — the gesture, the setting,
    // the command and the overlay's box.
    //
    // The docked pane's `visible` flag is deliberately not part of this. Entering
    // Focus Mode clears it (that is how the pane is hidden there), so gating the
    // overlay on it would mean the one layout that needs the overlay could never
    // open it. What the overlay needs is a document to show — the same question
    // every other PDF command asks with `context.hasPdf` — and the pane's own
    // visibility keeps governing whether it is *docked*.
    const floatEnabled = state.layout === 'editor' && state.pdf.path !== null;
    const focusFloat = useFocusPdfFloat(floatEnabled);
    const [floatWidth, setFloatWidth] = useState(() => focusFloatWidth());
    /**
     * The first reveal waits for the CSS transition, so the viewer arrives
     * rather than appears. Every later one is instant: the overlay stays mounted
     * (hidden) once it has been shown, and a viewer that fades in on every Alt
     * would look like it was being reopened each time.
     */
    const [floatSettled, setFloatSettled] = useState(false);
    const floatOpen = focusFloat.open;
    useEffect(() => {
        if (!floatOpen || floatSettled) return;
        const timer = setTimeout(() => setFloatSettled(true), FOCUS_FLOAT_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [floatOpen, floatSettled]);

    /**
     * The room the overlay gets inside the application shell: from under the
     * title bar to above the status bar, so it never covers the window's own
     * chrome — neither the drag region and window controls at the top nor the
     * build/cursor readout at the bottom.
     */
    const [floatBounds, setFloatBounds] = useState(() => focusFloatTop());
    useEffect(() => {
        if (!floatEnabled) return;
        const measure = () => setFloatBounds(focusFloatTop());
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [floatEnabled, state.statusBarVisible]);

    // The palette's toggle, over the channel the `pdf.*` commands already use.
    const toggleFloatRef = useRef(focusFloat.toggle);
    toggleFloatRef.current = focusFloat.toggle;
    useEffect(() => globalEvents.on('pdf:focusFloat', () => toggleFloatRef.current()), []);

    useApplicationCommands();
    // ------------------------------------------------------------ editor bridge
    useEffect(() => {
        setEditorBridge({
            revealPosition: (line, column) => state.editorHandleRef.current?.revealPosition(line, column), revealOffset: (offset) => state.editorHandleRef.current?.revealOffset(offset),
            getCursorOffset: () => state.editorHandleRef.current?.getCursorOffset() ?? null, insertText: (text) => state.editorHandleRef.current?.insertText(text),
            applyEdits: (edits) => {
                const doc = state.activeDoc;
                if (!doc)
                    return;
                doc.applyDeltas(edits, 'code');
            },
            getSelectionOffsets: () => {
                const selection = state.editorHandleRef.current?.getSelectionOffsets();
                return selection ? {
                    from: selection.from, to: selection.to
                }
                    : null;
            }
        });
        return () => setEditorBridge(null);
    }, [state]);
    // ------------------------------------------------------- auto-save triggers
    //
    // `files.autoSave`'s trigger modes. The window losing focus is reported here
    // and the editor losing focus comes from the editor itself (below, through
    // `onFocusChange`); both are handed to the workspace, which owns the decision
    // of what the current mode makes of them — `onWindowChange` acts on the first
    // and `onFocusChange` on either, exactly as VS Code's own table does.
    // `afterDelay` is not here at all: that mode's timer belongs to the document
    // that changed, and the workspace arms it.
    useEffect(() => {
        const handleWindowBlur = () => {
            void state.runAutoSave('windowFocusLost');
        };
        window.addEventListener('blur', handleWindowBlur);
        return () => window.removeEventListener('blur', handleWindowBlur);
    }, [state]);
    // ------------------------------------------------------------ drag and drop
    //
    // `dropActive` is the drop target's own feedback: while a file is over the
    // stage the pane is outlined, so "you can drop this here" is answered before
    // the drop rather than by whether the drop happened to work.
    const [dropActive, setDropActive] = useState(false);
    const handleEditorDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDropActive(true);
        }
    }, []);
    const handleEditorDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        // A drag leaving for a child of the stage still fires `dragleave` on the
        // stage; `relatedTarget` is what tells the two apart.
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
            return;
        setDropActive(false);
    }, []);
    const handleEditorDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
        setDropActive(false);
        if (!event.dataTransfer.files || event.dataTransfer.files.length === 0)
            return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        for (const file of files) {
            const filePath = window.eukoliaApi.getPathForFile(file);
            if (!filePath)
                continue;
            const isTex = /\.(tex|ltx|bib|sty|cls|txt|md|log|json|yaml|yml|cfg|toml|tikz|def|dtx|ins)$/i.test(filePath);
            const isImage = /\.(png|jpe?g|pdf|eps|svg)$/i.test(filePath);
            if (isImage && state.activeDoc) {
                const docDir = state.activeDoc.uri.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/');
                const normalizedPath = filePath.replace(/\\/g, '/');
                let relPath = normalizedPath;
                if (normalizedPath.startsWith(docDir + '/')) {
                    relPath = normalizedPath.slice(docDir.length + 1);
                }
                else if (state.workspace.workspacePath) {
                    const ws = state.workspace.workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
                    if (normalizedPath.startsWith(ws + '/')) {
                        relPath = normalizedPath.slice(ws.length + 1);
                    }
                }
                const snippet = `\\includegraphics{${relPath}}`;
                if (state.editorHandleRef.current) {
                    state.editorHandleRef.current.insertText(snippet);
                }
                else {
                    const offset = state.cursor?.offset ?? state.activeDoc.getLength();
                    state.activeDoc.replaceRange(offset, offset, snippet, 'code');
                }
                state.setStatusMessage(`Inserted \\includegraphics{${relPath}}`);
            }
            else if (isTex) {
                await state.openFile(filePath);
                state.setStatusMessage(`Opened ${filePath.split(/[\\/]/).pop()}`);
            }
            else {
                await state.openFile(filePath);
            }
        }
    }, [state]);
    // ------------------------------------------------------------ global keys
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const isTypingField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;
            // The focused PDF viewer owns the keys light-pdf binds.
            //
            // This handler runs in the capture phase, so without this check the
            // application would take `Ctrl+2` (Visual Mode) before the viewer could
            // use it for `Zoom: Fit Width`, and light-pdf's own accelerators would
            // only work where they do not collide. The viewer's binding wins wherever
            // it applies, which is what "the viewer behaves like light-pdf" requires.
            if (!isTypingField && target?.closest?.('[data-testid="pdf-pane-root"]') && matchViewerAccelerator({
                key: event.key, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey,
                metaKey: event.metaKey
            }) !== null) {
                return;
            }
            const commandId = commandRegistry.resolveKeybinding(event);
            if (!commandId)
                return;
            if (isTypingField && !GLOBAL_OVERLAY_COMMANDS.has(commandId))
                return;
            event.preventDefault();
            event.stopPropagation();
            void commandRegistry.execute(commandId);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);
    // ------------------------------------------------------- escape from panes
    //
    // Escape steps back out of Settings: it leaves the section it is showing
    // first (the keyboard-shortcut editor and the snippet manager replace the
    // pane's whole body, so they have somewhere of their own to go) and closes
    // the pane from the category list. `escapeFromSettings` is the rule; this is
    // the wiring.
    //
    // It is resolved here, in one handler, rather than by a second listener inside
    // `SettingsView`: two listeners both watching for Escape would each act on the
    // same press and dismiss two levels at once. The listener stays mounted while
    // the pane is closed so that its registration order cannot change under it —
    // the rule simply answers `none`.
    //
    // This runs in the bubble phase, so an element that handles Escape itself (a
    // text field cancelling an edit, the shortcut recorder) has already acted.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape')
                return;
            const action = escapeFromSettings(state);
            if (action === 'none')
                return;
            event.preventDefault();
            if (action === 'leave-section')
                state.openSettingsSection(SETTING_CATEGORIES[0]);
            else
                state.toggleSettings();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [
        state.settingsOpen,
        state.settingsSection,
        state.paletteOpen,
        state.quickOpenOpen,
        state.shortcutsOpen,
        state.aboutOpen,
        state.buildPickerOpen,
        state.snippetsOpen,
        state.toggleSettings,
        state.openSettingsSection
    ]);
    // Commands dispatched from the main process menu.
    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<string>).detail;
            if (detail)
                void commandRegistry.execute(detail);
        };
        window.addEventListener('eukolia:menu-command', handler as EventListener);
        return () => window.removeEventListener('eukolia:menu-command', handler as EventListener);
    }, []);
    // ------------------------------------------------------------- SyncTeX
    useEffect(() => {
        const offForward = globalEvents.on('synctex:forward', () => {
            void (async () => {
                const doc = state.activeDoc;
                const pdfPath = state.pdf.path;
                if (!doc || !pdfPath) {
                    state.setStatusMessage('SyncTeX needs an open document and a built PDF');
                    return;
                }
                const root = projectIndex.getRootDocumentPath();
                const buildDir = root ? root.replace(/[\\/][^\\/]*$/, '') : doc.uri.replace(/[\\/][^\\/]*$/, '');
                try {
                    const result = await window.eukoliaApi.synctexForward({
                        synctexPath: pdfPath.replace(/\.pdf$/i, '.synctex.gz'), file: doc.uri, line: state.cursor.line,
                        column: state.cursor.column, buildDir
                    });
                    if (!result) {
                        state.setStatusMessage('SyncTeX: no match for the cursor position');
                        return;
                    }
                    pdfHandleRef.current?.scrollToPosition(result.page, result.x, result.y);
                    state.setStatusMessage(`SyncTeX: page ${result.page}`);
                }
                catch (err) {
                    state.setStatusMessage(`SyncTeX failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
        });
        const offInverse = globalEvents.on('synctex:inverse', (payload: unknown) => {
            const request = payload as {
                page: number;
                x: number;
                y: number;
            } | null;
            const pdfPath = state.pdf.path;
            if (!request || !pdfPath)
                return;
            void (async () => {
                try {
                    const result = await window.eukoliaApi.synctexInverse({
                        synctexPath: pdfPath.replace(/\.pdf$/i, '.synctex.gz'), page: request.page, x: request.x,
                        y: request.y
                    });
                    if (!result) {
                        state.setStatusMessage('SyncTeX: no source position found');
                        return;
                    }
                    await state.goToSource(result.file, result.line, result.column);
                    state.setStatusMessage(`SyncTeX: ${result.file.replace(/^.*[\\/]/, '')}:${result.line}`);
                }
                catch (err) {
                    state.setStatusMessage(`SyncTeX failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
        });
        const offPage = globalEvents.on('pdf:goToPage', (page: unknown) => {
            if (typeof page === 'number')
                pdfHandleRef.current?.goToPage(page);
        });
        return () => {
            offForward();
            offInverse();
            offPage();
        };
    }, [state]);
    // ------------------------------------------------------------ PDF search
    // The find UI moved into the PDF pane (light-pdf's floating find bar), so the
    // query, its case sensitivity and the "n / m" counter are owned there.
    // ---------------------------------------------------------------- panes
    const active = state.activeDoc;
    /**
     * The one editor. Code Mode and Visual Mode are the *same* component over
     * the *same* CodeMirror view: `state.editorMode` only decides whether the
     * visual extensions are on, so the index bar, the scrollbar,
     * the scroll position and the caret are the same objects in both modes and
     * `Ctrl+1` / `Ctrl+2` is a change of mode rather than of editor.
     */
    const editorPane = useMemo(() => active ? (<LazyVisualEditor getText={() => active.getText()} applyChange={(change) => active.replaceRange(change.from, change.to, change.insert, state.editorMode === 'visual' ? 'visual' : 'code')} filePath={active.uri} theme={state.themeAppearance} startVisual={state.editorMode === 'visual'} handleRef={state.editorHandleRef} 
    // The compiler's errors, from the same list the Problems panel shows; the
    // editor draws only the ones naming the open document and keeps them beside
    // the linter's own, which run in the editor.
    diagnostics={state.diagnostics} 
    // LaTeX navigation: go-to-definition (`F12`, `Mod`-click), Find All
    // References (`Shift+F12`) and clickable `\input{...}` / URL links. Opening
    // a file goes through `goToSource`, the path SyncTeX already uses, so a
    // definition lands on its line with the caret showing.
    navigation={{
            openFile: (path, line, column) => void state.goToSource(path, line ?? 1, column ?? 1),
            showReferences: (label, occurrences) => {
                if (occurrences.length === 0) {
                    state.setStatusMessage(`No references to ${label}`);
                    return;
                }
                const first = occurrences[0];
                state.setStatusMessage(`${label}: ${occurrences.length} reference${occurrences.length === 1 ? '' : 's'} — first at ${first.file.split(/[\\/]/).pop()}:${first.line}`);
            }
        }} 
    // The status bar's position index and the breadcrumbs are fed from the
    // editor's own selection, which is why the index reads identically in both
    // modes: it is one editor reporting one caret.
    onSelectionChange={(selection) => state.setCursor({
            line: selection.line, column: selection.column, offset: selection.head,
            selectedChars: Math.abs(selection.head - selection.anchor)
        })} 
    // A document that opened with fewer capabilities than usual says so, once, on
    // the status bar the rest of the application already talks through.
    onNotice={(message) => state.setStatusMessage(message)}
    // The editor's own focus, which is what `files.autoSave`'s `onFocusChange`
    // mode saves on. The loss is reported and the gain is not: leaving the editor
    // is the event, whether the focus went to the file tree, the terminal, the
    // PDF viewer or another application.
    onFocusChange={(focused) => {
            if (!focused)
                void state.runAutoSave('editorFocusLost');
        }}/>) : null, [
        active,
        state.editorMode,
        state.themeAppearance,
        state.editorHandleRef,
        state.diagnostics,
        state.goToSource,
        state.setStatusMessage,
        state.setCursor,
        state.runAutoSave
    ]);
    /**
     * The editor and the viewer are the two surfaces that arrive as their own
     * chunks, so each gets a boundary: the pane keeps its box while the module is
     * fetched, and the shell does not unmount around it.
     */
    const editorSurface = useMemo(() => <Deferred label="Loading editor…">{editorPane}</Deferred>, [editorPane]);
    /**   * light-pdf's `CmdOpenFile` from the viewer's own toolbar: pick another   * document for the PDF pane to show. The dialog is restricted to PDFs because   * this is the viewer's toolbar, not the LaTeX project's file opener.   */ const openPdfFile = useCallback(async () => {
        const files = await window.eukoliaApi.openFileDialog([{
                name: 'PDF documents', extensions: ['pdf']
            },
            {
                name: 'All files', extensions: ['*']
            }
        ]);
        if (files.length > 0)
            state.setPdfPath(files[0]);
    }, [state]);
    const pdfInvert = resolveInvert(state.themeAppearance);
    const pdfPane = useMemo(() => (<LazyPdfPane path={state.pdf.path} appearance={state.themeAppearance} handleRef={pdfHandleRef} invertColors={pdfInvert} initialZoom={pdfZoom} initialZoomMode={pdfZoomMode} onOpenFile={() => void openPdfFile()} 
    // light-pdf's `CmdInvertColors` (`Shift+I`): flip the setting the pane
    // already reads, so the keyboard and the setting stay one source of truth.
    onToggleInvertColors={() => settingsManager.setValue('pdf.invertColors', pdfInvert ? 'never' : 'always', 'user')} onZoomChange={(zoom, mode) => {
            setPdfZoom(zoom);
            setPdfZoomMode(mode);
            state.setPdfState({
                zoom, zoomMode: mode
            });
        }} onPageChange={(page, pageCount) => state.setPdfState({
            page, pageCount
        })} onDocumentLoaded={(info) => state.setPdfState({
            pageCount: info.pageCount, loading: false, error: null
        })} onError={(message) => state.setPdfState({
            error: message, loading: false
        })} onInverseSearch={(page, x, y) => globalEvents.emit('synctex:inverse', {
            page, x, y
        })} 
    // light-pdf's `CmdReloadDocument` (`R`), wired to the same reload the
    // palette command performs.
    onReload={() => {
            const path = state.pdf.path;
            if (!path)
                return;
            state.setPdfPath(null);
            setTimeout(() => state.setPdfPath(path), 50);
        }}/>), [state.pdf.path, state.themeAppearance, pdfInvert, pdfZoom, pdfZoomMode, openPdfFile, state.setPdfState, state.setPdfPath]);
    /**
     * The viewer's chunk is fetched when the pane is first rendered, and the pane
     * is what the boundary wraps — so a window that never shows a PDF never loads
     * the viewer at all, and a window that does keeps the pane's box while the
     * module arrives.
     */
    const pdfSurface = useMemo(() => <Deferred label="Loading PDF viewer…">{pdfPane}</Deferred>, [pdfPane]);
    /**
     * Focus Mode's overlay holds the same element the docked layouts do — the
     * same `PdfPane`, in the same position in the tree, so switching between a
     * docked viewer and the floating one carries the open document, the page,
     * the zoom and the scroll position across rather than reopening the file
     * (`Instructions.md` §43).
     *
     * It is rendered once the overlay has been revealed and left mounted
     * afterwards: the viewer inside it stays open and measured while the overlay
     * is away, so the next Alt is a paint rather than a re-open.
     */
    const floatingPdfPane = floatEnabled && floatSettled ? (<FocusPdfFloat top={floatBounds.top} bottom={floatBounds.bottom} width={floatWidth} open={floatOpen} onResize={(width) => {
                setFloatWidth(width);
                rememberFocusFloatWidth(width);
            }} onPointerInside={(inside) => focusFloat.setPointerInside(inside)}>{pdfSurface}

        </FocusPdfFloat>) : null;
    /**
     * Whether the PDF is docked beside the editor.
     *
     * Focus Mode is deliberately absent from this: `setLayout('editor')` clears
     * `pdf.visible` (`state.tsx`), so in Focus Mode there is nothing to dock —
     * and now nothing needs to be, because the overlay is where that layout
     * shows the viewer. A user who turned the docked pane back on while in Focus
     * Mode gets the split back, which is what `pdf.toggleViewer` means there.
     */
    const showPdf = state.layout !== 'editor' && state.pdf.visible;
    const workspaceArea = useMemo(() => {
        if (!active && state.layout !== 'pdf')
            return <EmptyWorkspace state={state}/>;
        if (state.layout === 'pdf')
            return <div style={{
                    flex: 1, minHeight: 0
                }}>{pdfSurface}

            </div>;
        if (state.layout === 'all') {
            /*
              "Code + Visual + PDF" used to be three panes over two editors. There
              is one editor now, and its mode lives in the editor's own state —
              not in the pane — so two panes would be the same editor twice, and
              two views of one state cannot show two modes. The pane is therefore
              shown once, beside the PDF, which is what the layout can honestly
              mean: the document being edited, and its typeset output.
            */
            return (<div style={{
                    display: 'flex', flex: 1, minHeight: 0
                }}>
          <div style={{
                    ...pane, flex: '1 1 50%'
                }}>{editorSurface}

            </div>
          <span style={paneSeam} />
          <div style={{
                    ...pane, flex: '1 1 50%'
                }}>{pdfSurface}

            </div>
        </div>);
        }
        if (state.layout === 'source-visual') {
            /*
              The same reasoning: source and visual are the two modes of the one
              editor (`Ctrl+1` / `Ctrl+2`), not two panes, so this layout shows
              the editor once at full width.
            */
            return <div style={{
                    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'
                }}>{editorSurface}

        </div>;
        }
        if (state.layout === 'visual-pdf') {
            return (<SplitPane direction="horizontal" initial={50} min={20} max={85} storageKey="eukolia.split.visual-pdf">
          <div style={pane}>{editorSurface}

            </div>
          <div style={pane}>{pdfSurface}

            </div>
        </SplitPane>);
        }
        if (showPdf) {
            return (<SplitPane direction="horizontal" initial={50} min={20} max={85} storageKey="eukolia.split.editor-pdf">
          <div style={pane}>{editorSurface}

            </div>
          <div style={pane}>{pdfSurface}

            </div>
        </SplitPane>);
        }
        return <div style={{
                flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'
            }}>{editorSurface}

        </div>;
    }, [active, editorSurface, pdfSurface, showPdf, state.layout]);
    // ------------------------------------------------------ sidebar resizing
    const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = sidebarWidth;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        let latest = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            latest = clampSidebarWidth(startWidth + (moveEvent.clientX - startX));
            setSidebarWidth(latest);
        };
        const onUp = () => {
            try {
                target.releasePointerCapture(event.pointerId);
            }
            catch {
                /* the pointer may already be released */
            }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            settingsManager.setValue('appearance.sidebarWidth', latest);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }, [sidebarWidth]);
    /**
     * The same resize from the keyboard.
     *
     * The handle is a focusable `separator`, and a control the keyboard can
     * reach has to do something when it is used: arrows step the width by 16px
     * (a coarse step, since the point is to reach a comfortable width rather
     * than to place an edge), Home and End go to the limits, and the value is
     * persisted exactly as the pointer drag persists it.
     */
    const onSidebarResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 48 : 16;
        let next: number | null = null;
        if (event.key === 'ArrowLeft') next = Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth - step);
        else if (event.key === 'ArrowRight') next = Math.min(SIDEBAR_MAX_WIDTH, sidebarWidth + step);
        else if (event.key === 'Home') next = SIDEBAR_MIN_WIDTH;
        else if (event.key === 'End') next = SIDEBAR_MAX_WIDTH;
        if (next === null) return;
        event.preventDefault();
        setSidebarWidth(next);
        settingsManager.setValue('appearance.sidebarWidth', next);
    }, [sidebarWidth]);
    /**
     * Hands the window over from the loading screen to the shell.
     *
     * One effect, one frame after `ready`, and the ordering is the whole point.
     * The loading screen is `position: fixed` over the window and painted by
     * `index.html`, so it is what the user has been looking at since before this
     * component existed. React has just committed the shell *underneath* it — so
     * the frame this effect runs after is the first frame with a shell to reveal,
     * and dismissing here is a cross-fade rather than a swap. Dismissing any
     * earlier would show a blank window; any later would cover the shell.
     *
     * `ready` is in the dependency list rather than the effect being placed after
     * the `null` return below: a hook may not sit below a conditional return, and
     * this component returns `null` on every render until the shell can be drawn.
     */
    useEffect(() => {
        if (!state.ready) return;
        const frame = requestAnimationFrame(() => dismissBootScreen());
        return () => cancelAnimationFrame(frame);
    }, [state.ready]);

    /**
     * Nothing until the shell can be drawn honestly.
     *
     * Not a spinner, and not a second loading screen: the one the user is looking
     * at belongs to `index.html` and is *outside this component's tree entirely*
     * (a sibling of `#root`, so React cannot clear it). Rendering a copy here
     * would mean two, and clearing the first would mean a frame with neither —
     * so this returns `null` and leaves the real one alone until the commit that
     * replaces it.
     *
     * The return is *here*, after every hook in this component, and that position
     * is load-bearing rather than stylistic. React identifies hooks by call order,
     * so a component that returns early from one render and continues from the
     * next violates the rules of hooks — it renders fewer hooks than the previous
     * render, which React reports as error #310 and which took the whole shell
     * down when this return sat above `workspaceArea`'s `useMemo`s. Everything
     * above runs on both renders; only the returned element differs.
     */
    if (!state.ready) return null;
    return (<div className="eu-shell" style={shell}>
      {/*
        The first Tab stop in the window, and the one piece of chrome that exists
        only for the keyboard. The shell is a tab strip, a sidebar and a status bar
        around a workspace, so a keyboard user reaching the editor from the top of
        the window has a dozen controls to pass first; this is the way past them,
        and it is invisible until it is focused.
      */}
      <a href="#eu-workspace" className="eu-skip-link">
        Skip to the editor
      </a>
      {/*
        There is no title bar here any more.

        The window is frameless (`titleBarStyle: 'hidden'`, main.ts) and its top
        row used to be a title bar: the File/Edit/View… menus, a command centre
        over the document title, four layout toggles, and the platform's three
        window buttons drawn over its right-hand end by `titleBarOverlay`. The row
        is gone. The menus are the sidebar's Menu view (`ui/appMenus.ts` is the
        structure behind it) and the command palette; the layout toggles are the
        status bar's own cluster and the tab bar's controls; and the window buttons
        are drawn by `ui/components/TabBar.tsx`, which is now the window's top edge
        — the drag region, the caption and the toolbar in one strip. Its module
        comment is where what moved is written down.
      */}
      <ProjectLibraryDialog />
      {/*
        A startup that failed the session read is still a usable application —
        what is missing is the workspace — so this is a banner across the top
        rather than a dialog. It is `role="alert"` because it arrives without
        anyone asking for it and says something the user needs to know.
      */}
      {state.bootError && (<div className="eu-boot-error" role="alert">
          <CircleAlert size={14} strokeWidth={2} />
          <span>Startup problem: {state.bootError}</span>
        </div>)}

      <div className="eu-stage">
        {/*
          The strip is the sidebar's own view switcher, so by default it comes
          and goes with the region it switches: leaving it behind puts the buttons
          for six panels on screen with none of those panels rendered.
          `appearance.collapseActivityBarWithSidebar` is the way out of that — off,
          the strip stays as a click target so the sidebar is always one click
          away.

          The rule follows the user's *request* to see the sidebar rather than the
          rendered result, so the strip survives the two cases where the region is
          withheld for a reason other than a collapse — no view chosen yet, and
          the settings pane occupying the slot — which is what keeps a view
          reachable from inside Settings.

        {/*
          The panel bar (ActivityBar) holds the Menu button at the top and panel
          buttons below. When `Toggle Panel Bar` is off (collapseWithSidebar is true),
          closing the sidebar completely removes the Panel Bar and wraps the Menu
          button into the top-left expandable button in the TabBar.
        */}
        {panelBarShown && <ActivityBar collapseWithSidebar={collapseWithSidebar} />}
        {/*
          One region, one condition: `sidebarShown` is the same answer the status
          bar button reports and `toggleSidebar` acts on, so the three cannot
          drift into disagreeing about whether the sidebar is on screen. The
          panels it holds — Explorer, Search, Outline, Symbols, Snippets,
          Problems — are views of this one element, so they come and go with it.
        */}
        {sidebarShown({ visible: state.sidebarVisible, view: state.sidebarView, settingsOpen: state.settingsOpen }) && (<>
            <div data-testid="sidebar-region" className="eu-sidebar-region eu-enter-left" style={{
                width: sidebarWidth, minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH
            }}>
              <Sidebar />
            </div>
            <div
              onPointerDown={startSidebarResize}
              onKeyDown={onSidebarResizeKeyDown}
              title="Drag to resize the sidebar · ← → to adjust"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the sidebar"
              aria-valuenow={Math.round(sidebarWidth)}
              aria-valuemin={SIDEBAR_MIN_WIDTH}
              aria-valuemax={SIDEBAR_MAX_WIDTH}
              tabIndex={0}
              className="eu-sidebar-resizer"
            />
          </>)}

        <div className="eu-workspace">
          {state.settingsOpen ? (
            <Deferred label={"Loading settings…"}>
              <div className="eu-settings-host">
                {!panelBarShown && (
                  <div className="eu-floating-menu-button">
                    <TopLeftMenuButton />
                  </div>
                )}
                <LazySettingsView />
              </div>
            </Deferred>
          ) : (
            <>
              {/*
                The tab bar is drawn in every layout, including the one with no
                tabs: it is the window's top edge — the drag region, the caption
                buttons and the toolbar — so `view.toggleTabBar` hides the
                *document tabs* inside it rather than the bar. Until this changed,
                the bar disappeared entirely and took the window controls with it.
              */}
              <TabBar panelBarShown={panelBarShown} />

              <div
                id="eu-workspace"
                tabIndex={-1}
                className={`eu-workspace__drop${dropActive ? ' eu-workspace__drop--active' : ''}`}
                onDragOver={handleEditorDragOver}
                onDragLeave={handleEditorDragLeave}
                onDrop={handleEditorDrop}
              >
                {workspaceArea}

              </div>

              <BottomPanel />
            </>)}

        </div>
      </div>

      {/*
        The light-pdf toolbar lives inside the PDF pane itself (see
        `src/renderer/pdf/PdfPane.tsx`), exactly as light-pdf puts its toolbar
        strip on top of the document window — there is no separate app-wide bar.
      */}

      {state.statusBarVisible && <StatusBar />}
      {
        /*
          Focus Mode's floating viewer. It is a sibling of the workspace rather
          than a child of it, which is the whole reason it floats: the editor
          keeps the layout it had, so revealing the viewer cannot re-wrap the
          paragraph being read (`Instructions.md` §37, one level up).

          It sits above the panes (z-index 5) and below every overlay the shell
          owns — the sidebar's menus (80), the tab switcher (60), the status
          bar (90), the modals (200) and the palette (220) — so a menu or a
          dialog opened from inside the viewer is never drawn behind it.
        */
        floatingPdfPane
      }

      {/*
        The palette and quick open are mounted only while they are open, so their
        chunks are fetched by the interaction that opens them rather than by the
        launch. Each already renders nothing when closed, so this changes when it
        loads and not what it does — and a list nobody has asked for is not read
        from disk.
      */}
      {state.paletteOpen && <LazyCommandPalette />}
      {state.quickOpenOpen && <LazyQuickOpen />}
      {/*
        `Ctrl+Tab`: hold Ctrl, press Tab to cycle, release Ctrl to switch.
      */}
      {/*
        `Ctrl+Tab` is the component's own listener, so this cannot be mounted on
        the keypress that opens it. It is mounted as soon as there is a document to
        switch between, which is also the first moment it can do anything.
      */}
      {state.documents.length > 0 && <LazyTabSwitcher />}
      <Modal open={state.shortcutsOpen} onClose={() => state.setShortcutsOpen(false)} title="Keyboard Shortcuts" width={780}>
        <ShortcutTable />
      </Modal>
      <Modal open={state.aboutOpen} onClose={() => state.setAboutOpen(false)} title="About Eukolia" width={560}>
        <AboutPanel />
      </Modal>
      {
        /*
          The snippet library is a window rather than a settings page: it is
          opened while writing (`Ctrl+Alt+L`), it takes nearly the whole window
          because the list and the form are both long, and closing it is what
          writes the file — the manager saves and then asks to be dismissed, so a
          library that cannot be written keeps the window (and the edits) open.
        */
        }
      {/*
        Mounted only while it is open. It is a 105 KB module — its own list, its
        own form, its own projection sandbox — and it is opened by a keyboard
        shortcut or a settings entry, so nothing on the opening screen can want it.
      */}
      {state.snippetsOpen && (
        <LazySnippetManager
          open
          focusSnippetId={state.snippetFocusId}
          onClose={() => state.setSnippetsOpen(false)}
          registerCloseHandler={state.registerSnippetsCloseHandler}
        />
      )}
      <Modal open={state.buildPickerOpen} onClose={() => state.setBuildPickerOpen(false)} title="Build with Recipe" width={520}>
        <div className="eu-build-recipes">
          {state.activeRecipes.length === 0 && (
            <div className="eu-empty">No recipes available.</div>
          )}

          {/*
            Every row is a recipe the *resolver* knows, because the list is read
            back out of the same settings the resolver reads. A row whose tools
            are not installed is still offered — the failure it produces names
            the missing command — but it says so before the click, which is the
            difference between choosing a recipe and discovering afterwards that
            this machine cannot run it.
          */}
          {state.activeRecipes.map((recipe) => (
            <button
              key={recipe.name}
              type="button"
              className="eu-list-button eu-build-recipes__row"
              data-recipe={recipe.name}
              data-available={recipe.available}
              title={
                recipe.available
                  ? `${recipe.name}\n${recipe.commands.join(' → ')}`
                  : `${recipe.name}\nNot runnable here: ${recipe.missing.join(', ')} not found on PATH`
              }
              onClick={() => {
                state.setBuildPickerOpen(false);
                void state.buildProject({ recipeName: recipe.name });
              }}
            >
              <span className="eu-build-recipes__name">{recipe.name}</span>
              <span className="eu-build-recipes__tools">{recipe.commands.join(' → ')}</span>
              {!recipe.available && (
                <span className="eu-build-recipes__missing">missing: {recipe.missing.join(', ')}</span>
              )}
            </button>
          ))}
        </div>
      </Modal>
    </div>);
};
// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
const EmptyWorkspace: React.FC<{state: ReturnType<typeof useAppState>}> = () => <LibraryHome />;

/**
 * The whole keyboard map, as a filterable table.
 *
 * Reached from Help → Open Keyboard Shortcuts (`Ctrl+K Ctrl+S`). It is a
 * *reading* surface rather than the editing one — Settings → Keyboard is where a
 * binding is changed — so each row shows the shortcut as a keycap and clears it
 * on request, and the filter matches the category, the title and the binding
 * together so any of the three is a way in.
 */
const ShortcutTable: React.FC = () => {
    const [version, setVersion] = useState(0);
    const [filter, setFilter] = useState('');
    const rows = useMemo(() => commandRegistry.getAllKeybindings(), [version]);
    const filtered = filter ? rows.filter((row) => `${row.category} ${row.title} ${row.binding}`.toLowerCase().includes(filter.toLowerCase())) : rows;
    return (<div className="eu-shortcut-table">
      <div className="eu-search">
        <Search size={13} strokeWidth={2} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by command, category or key…"
          aria-label="Filter shortcuts"
          className="eu-input"
          spellCheck={false}
        />
      </div>
      <div className="eu-shortcut-table__scroll eu-scroll">
        {filtered.map((row) => (
          <div key={`${row.commandId}-${row.binding}`} className="eu-shortcut-row">
            <span className="eu-shortcut-row__category">{row.category}</span>
            <span className="eu-shortcut-row__title eu-truncate">{row.title}</span>
            <code className="eu-kbd">{row.binding}</code>
            <button
              type="button"
              className="eu-icon-btn eu-pressable"
              style={{ width: 20, height: 20 }}
              title={`Clear the binding for ${row.title}`}
              aria-label={`Clear the binding for ${row.title}`}
              onClick={() => {
                commandRegistry.setKeybinding(row.commandId, null);
                setVersion((value) => value + 1);
              }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="eu-empty">No shortcuts match “{filter}”.</div>
        )}
      </div>
      <div className="eu-eyebrow" style={{ textTransform: 'none', letterSpacing: 0 }}>
        Bindings can also be changed from Settings → Keyboard.
      </div>
    </div>);
};

/** What the window is made of: the version readout, and nothing else. */
const AboutPanel: React.FC = () => {
    const [versions, setVersions] = useState<Record<string, string> | null>(null);
    useEffect(() => {
        void window.eukoliaApi.getVersions().then(setVersions);
    }, []);
    return (<div className="eu-about">
      <div className="eu-about__wordmark">
        <span className="eu-about__mark">E</span>
        <span>Eukolia</span>
      </div>
      <div className="eu-about__tagline">
        A fast, modern, extensible, and purpose-built LaTeX editing environment.
      </div>
      <dl className="eu-about__versions">
        {versions && Object.entries(versions).map(([key, value]) => (
          <React.Fragment key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>);
};
// ---------------------------------------------------------------------------
// Helpers and styles// ---------------------------------------------------------------------------
function resolveInvert(theme: 'light' | 'dark'): boolean {
    const mode = setting.str('pdf.invertColors');
    if (mode === 'always')
        return true;
    if (mode === 'whenThemeDark')
        return theme === 'dark';
    return false;
}
/**
 * The rule between two panes in a layout that is not resizable.
 *
 * It is the same 1px ar(--eu-border) the resizable SplitPane draws, so the
 * seam looks identical wherever it appears — but deliberately *not* the
 * .eu-panel-divider class, whose hover highlight means "you can drag this".
 * A static divider that lights up on hover would promise a drag that does not
 * exist.
 */
const paneSeam: React.CSSProperties = {
    width: 1,
    alignSelf: 'stretch',
    flexShrink: 0,
    background: 'var(--eu-border)'
};

/**
 * How long Focus Mode's overlay keeps its slide-and-fade on.
 *
 * The first reveal is the one transition worth having: it says where the viewer
 * came from and that it is floating rather than docked. After that the overlay
 * is left mounted, so a later Alt is a paint and a transition on it would read
 * as the document being reopened every time — so the animation is turned off
 * once it has played.
 */
const FOCUS_FLOAT_SETTLE_MS = 220;

/**
 * Where the floating viewer's box starts and ends inside the shell.
 *
 * It runs from under the tab bar to above the status bar, so the window's own
 * chrome stays usable: the tab bar is the frameless window's drag region, its
 * caption buttons and its toolbar, and the status bar carries the build and
 * cursor readouts. Both are measured rather than assumed because both can be
 * switched off (`appearance.showStatusBar`, `view.toggleStatusBar`), and an
 * overlay that covered either would be a piece of the window the user could no
 * longer reach.
 *
 * The shell's own top edge is the reference for both numbers, so the overlay
 * positions correctly however the window is offset on screen.
 */
function focusFloatTop(): { top: number; bottom: number } {
    if (typeof document === 'undefined') return { top: 0, bottom: 0 };
    const bar = document.querySelector('[data-testid="tab-bar"]');
    const status = document.querySelector('[data-testid="status-bar"]');
    return {
        top: bar instanceof HTMLElement ? Math.max(0, Math.round(bar.getBoundingClientRect().height)) : 0,
        bottom: status instanceof HTMLElement ? Math.max(0, Math.round(status.getBoundingClientRect().height)) : 0
    };
}

const pane: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%'
};
const shell: React.CSSProperties = {
    fontSize: 13
};
const textInput: React.CSSProperties = {
    width: '100%'
};
export const App: React.FC = () => (<AppStateProvider>
    <AppShell />
  </AppStateProvider>);
export default App;



