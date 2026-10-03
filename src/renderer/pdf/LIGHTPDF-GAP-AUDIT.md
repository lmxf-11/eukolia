# light-pdf → Eukolia PDF viewer: feature, command and settings gap audit

Reference: `References/light-pdf/` (full checkout) and the vendored engine sources in
`src/native/pdf/lightpdf/`. Where the reference's docs and its source disagree, the source
decides. Line numbers below are the reference's own.

Status key:

| mark | meaning |
|---|---|
| **yes** | Eukolia's PDF pane honours it today |
| **partly** | honoured, but through an Eukolia mechanism or with a documented difference |
| **no** | light-pdf has it; Eukolia does not yet. The reason is given |
| **n/a** | deliberately out of scope for a viewer embedded in an editor (not quietly dropped — see §7) |

---

## 1. Settings — the `LightPDF-settings.txt` keys

light-pdf's preferences are defined once, in `cmd/gen-settings.ts` (`globalPrefs`, lines
597–1006), serialised by `src/base/SettingsUtil.cpp`, normalised in `AppSettings.cpp`, and
edited either in the Options dialog (only **8** widgets, `LightDialogs.cpp:850-932`) or in
the generated "Advanced Settings" list (`AdvancedSettingsDialog.cpp:813-951`; arrays and
compact structs are skipped there, `:237-240`).

The captured run at `References/light-pdf/out/dbg64/LightPDF-settings.txt` is a real file:
its "captured" column below is what that run wrote, which shows both the default and that
light-pdf persists the key.

### 1.1 Top-level scalar settings

| key | default (`gen-settings.ts`) | captured | what it does (where light-pdf reads it) | Eukolia |
|---|---|---|---|---|
| `EnableCollapseShortcut` | `true` | `true` | global `Alt+L` collapses/restores the window (`LightPDF.cpp:2174`) | n/a — window chrome belongs to Electron |
| `DefaultDisplayMode` | `automatic` | `automatic` | page layout for new documents (`AppSettings.cpp:332`, `LightPDF.cpp:1643`) | **yes** — `pdf.scrollMode` |
| `DefaultZoom` | `fit page` | `fit page` | zoom for new documents (`LightPDF.cpp:1644`) | **yes** — `pdf.defaultZoom` |
| `DisableJavaScript` | `false` | `false` | PDF JavaScript off (`AppSettings.cpp:320` → `EngineMupdf.cpp:3275-3283`) | **no** — the frozen render contract has no JS switch; needs a native-engine flag (Eukolia's MuPDF build does not enable JS either way) |
| `AllowExternalImages` | `false` | `false` | allow images in a sibling file (`AppSettings.cpp:321`) | **no** — native engine flag, `src/shared/ipc.ts` has no field for it |
| `EnableTeXEnhancements` | `false` | `false` | makes SyncTeX inverse search available (`Canvas.cpp:1604`) | **yes** — SyncTeX is always on in Eukolia (no gate needed) |
| `EscToExit` | `false` | `false` | `Esc` closes the window (`LightPDF.cpp:6200`) | n/a — the app has its own Escape semantics; the viewer's Escape clears search/selection |
| `FullPathInTitle` | `false` | `false` | full path in the title bar / tab tooltip (`LightPDF.cpp:1531`, `Tabs.cpp:48`) | n/a — no per-document window title |
| `InverseSearchCmdLine` | *(unset)* | *(unset)* | command launched by inverse search (`SearchAndDDE.cpp:1580`) | n/a — built-in SyncTeX replaces the external-editor command line |
| `LazyLoading` | `false` | `false` | session restore defers loading a tab until selected (`LightPDF.cpp:3076`) | n/a — one document per pane |
| `MainWindowBackground` | `#80fff200` | `#80fff200` | light theme's window/canvas background (`Theme.cpp:469-479`) | **yes** — `pdf.mainWindowBackground` (light theme only, default = "not set", exactly as `IsDefaultMainWinColor` decides; `Theme.cpp:305`) |
| `NoHomeTab` | `false` | `false` | no Home tab (`Tabs.cpp:677`) | n/a |
| `HomePageSortByFrequentlyRead` | `false` | `false` | Home list ordering (`HomePage.cpp:1190`) | n/a |
| `HomePageViewMode` | `thumbnails` | `thumbnails` | Home grid vs list (`HomePage.cpp:1058`) | n/a |
| `ReloadModifiedDocuments` | `true` | `true` | reload when the file changes on disk (`LightPDF.cpp:2614`) | **partly** — the pane re-opens the file when the build replaces it (Eukolia drives builds itself); there is no watcher setting |
| `RememberOpenedFiles` | `true` | `true` | file history / session master switch (`LightPDF.cpp:156`) | **partly** — `general.restoreSession` covers Eukolia's session |
| `RememberStatePerDocument` | `true` | `true` | keep display settings per document (`LightPDF.cpp:1629`, `DisplayModel.cpp:278`) | **yes** — `lightpdf-viewstate.ts` (in memory only; Eukolia has no settings-file file-state list) |
| `RestoreSession` | `true` | `true` | restore `SessionData` at startup (`LightPDF.cpp:152`) | **partly** — `general.restoreSession` |
| `ReuseInstance` | `true` | `true` | open in the existing process (`LightStartup.cpp:2202`) | n/a — Electron's single-instance handling |
| `ShowMenubar` | `true` | `true` | menu bar visible (`LightPDF.cpp:806`) | n/a — Eukolia's own menu bar |
| `ShowMenubarWithTabs` | `false` | `false` | menu bar while tabs are used (`Menu.cpp:2499`) | n/a |
| `ShowTips` | `true` | `true` | tips on the home page (`HomePage.cpp:1356`) | n/a |
| `CustomColors` | *(unset)* | *(unset)* | 13 swatches for the colour picker (`LightDialogs.cpp:1232`) | n/a (its only consumer is a dialog Eukolia does not have) |
| `ShowToolbar` | `true` | `true` | legacy toolbar visibility (`LightPDF.cpp:1158`) | **yes** — subsumed by `pdf.toolbar` (`show`/`hide`/`overlay`), the same way `AppSettings.cpp:400-407` keeps the two in step |
| `Toolbar` | *(unset → from `ShowToolbar`)* | `show` | toolbar mode (`LightPDF.cpp:1155`) | **yes** — `pdf.toolbar` |
| `ToolbarPosition` | `top` | `top` | toolbar top or bottom (`LightPDF.cpp:1185`) | **yes** — `pdf.toolbarPosition` |
| `SearchUIFloating` | `false` | `false` | find UI as a floating window with results (`FindBar.cpp:427`) | **no** — needs the find window; the frozen search contract returns rects only, and the pane implements light-pdf's *bar* (`LightPDF_FIND_BAR_BUTTONS`) |
| `ShowFavorites` | `false` | `false` | Favorites sidebar (`LightPDF.cpp:766`) | **no** — favourites (per-document page bookmarks) are unimplemented; see §4 |
| `ShowToc` | `true` | `true` | bookmarks sidebar *when the document has one* (`LightPDF.cpp:1597-1598, 1648-1668`) | **yes** — `pdf.showToc` + `F12`; the sidebar is new in this round (`LightPdfToc.tsx`) |
| `ShowLinks` | `false` | `false` | the blue link rectangles (`Canvas.cpp:1830`, drawn `:1829-1857`) | **yes** — `pdf.showLinks`; applied to the viewer's link rectangles by a pane-scoped CSS outline (1px `#0000ff`, offset 2px — light-pdf's pen and `Inflate(2,2)`) |
| `ShowStartPage` | `true` | `true` | home page when nothing is loaded (`LightPDF.cpp:2008`) | n/a |
| `SidebarDx` | `0` | `0` | sidebar width (`TableOfContents.cpp:1290`, `Favorites.cpp:925`) | **partly** — the bookmarks sidebar has a fixed 220px width, as light-pdf's is a remembered window dimension rather than a user setting (internal, no UI control in light-pdf either) |
| `Scrollbars` | `windows` | `windows` | `windows`/`smart`/`overlay`/`hidden` (`LightPDF.cpp:1129`) | **yes** — `pdf.scrollbar`, defaulting to `smart` rather than to light-pdf's `windows`: the platform bar is drawn *inside* the pane and reserves its width, so a page at `fit width` is laid out for a client box one scrollbar narrower and a strip of background sits at the window's right edge. `smart` draws light-pdf's own overlay bar over the page instead (`LightPDF.cpp:1140-1150`), which reserves nothing; `windows`, `overlay` and `hidden` behave exactly as the reference's. `CmdChangeScrollbar` (232) picks between the four |
| `ScrollbarInSinglePage` | `false` | `false` | scrollbar as a page slider in single-page mode (`Canvas.cpp:642`) | **yes** — `pdf.scrollbarInSinglePage`; in `single-page` the bar's position *is* the page number |
| `SmoothScroll` | `true` | `true` | momentum wheel scrolling (`Canvas.cpp:2730`) | **yes** — `pdf.smoothScroll`. Every event with a delta feeds the integrator (`planLightPdfWheel`), where the reference gates on a whole `WHEEL_DELTA`: Windows sends one message per notch, a browser sends one per hardware report, so the gate made most events answer "nothing" after `preventDefault` — the "the wheel sometimes does not respond" defect |
| `SmoothScrollFriction` | `0.2` | `0.2` | velocity decay, `exp(-friction*50*dt)` (`Canvas.cpp:2285`) | **yes** — `pdf.smoothScrollFriction`, consumed by the viewer's own integrator (`LightPdfSmoothScroll`) |
| `ScrollSensitivity` | `2.0` | `3` | wheel delta multiplier (`Canvas.cpp:2586-2588`) | **yes** — `pdf.scrollSensitivity`, read live by the wheel handler. It defaults to 3 rather than to light-pdf's 2.0. Because `:2738` scales the impulse by the sensitivity as well, on a `targetDistance` that `:2587` had already scaled, a gliding notch travels `24 * S²` — 216 px here against light-pdf's 96 — while the plain line path (`pdf.smoothScroll` off, and the Shift-redirected wheel) travels `48 * S`, 144 px. The departure is in the descriptor, and `lightPdfScrollSensitivity` keeps light-pdf's own 2.0 for a value that is missing or nonsense, exactly as `ScrollbarModeFromPrefs` keeps `windows` |
| `CitationHoverDelay` | `-1` | `-1` | hover an internal link → render the target region (`Canvas.cpp:1066`) | **no** — needs region rendering and a popup; not in the frozen contract |
| `ReadAloudVoiceId` | *(unset)* | *(unset)* | TTS voice (`AppSettings.cpp:53`) | n/a — no text-to-speech in Eukolia (a browser TTS backend would be a new feature) |
| `ReadAloudSpeed` | `1` | `1` | TTS speed (`LightPDF.cpp:10239`) | n/a — same |
| `FastScrollOverScrollbar` | `false` | `false` | faster wheel while over the scrollbar (`Canvas.cpp:2718-2728`) | **yes** — `pdf.fastScrollOverScrollbar` |
| `PreventSleepInFullscreen` | `true` | `true` | `SetThreadExecutionState` in fullscreen (`LightPDF.cpp:5915`) | n/a — no fullscreen/presentation mode in the renderer (Electron menu role only) |
| `TabWidth` | `300` | `300` | tab width (`Tabs.cpp:112`) | n/a |
| `Theme` | `""` (→ light) | `Light` | viewer theme name (`Theme.cpp:372`) | **yes** — `pdf.lightPdfTheme` (default `auto`, i.e. follow the app, as "System" does) |
| `LastLightTheme` / `LastDarkTheme` | `""` | `Light` / — | themes the System/dark toggle returns to (`Theme.cpp:319,327`) | **partly** — `pdf.lightPdfTheme = auto` resolves through `lightPdfThemeIndexFor(appearance)` |
| `DocumentColorsFollowTheme` | `off` | `off` | pages + canvas follow the theme: `off`/`smart`/`legacy` (`PdfDarkModeColor.cpp:102-116`) | **yes** — `pdf.documentColorsFollowTheme`; canvas colours via `themeDocumentColors`, page recolouring via the engine's raster invert. light-pdf's `smart` falls back to `LegacyInvert` for engines without object-level dark mode (`PdfDarkModeProfile.cpp:108-123`), which is exactly Eukolia's engine, so `smart` and `legacy` recolour the same way here — stated in the setting's description rather than hidden |
| `TocDy` | `0` | `0` | height of the bookmarks part beside Favorites (`LightPDF.cpp:5055`) | n/a — no Favorites panel |
| `ToolbarSize` | `18` | `18` | **icon** size (`Toolbar.cpp:1283`; clamped 8…64 in `AppSettings.cpp:390-393`) | **yes** — `pdf.toolbarSize` |
| `TreeFontName` / `TreeFontSize` | `automatic` / `0` | `automatic` / `0` | bookmarks/favourites tree font (`AppSettings.cpp:855-862`) | **no** — the sidebar uses the app font; a font-name setting would need the browser font stack (Eukolia's `editor.fontFamily`/`visual.fontFamily` are its equivalents) |
| `UIFontSize` | `0` | `0` | application font size (`AppSettings.cpp:802`) | **partly** — `appearance.uiDensity` covers the chrome |
| `DisableAntiAlias` | `false` | `false` | `fz_set_aa_level(ctx, 0)` (`EngineMupdf.cpp:4095-4100`) | **no** — native render flag; would need a `pdfRender` field and a native build |
| `EngineeringDrawingEnhance` | `auto` | `auto` | CAD line rendering: `off`/`auto`/`on` (`PdfCadDetect.cpp:20-28`) | **no** — native engine feature (line width at render, `EngineMupdf.cpp:4106`) |
| `DisableAutoLinks` | `false` | `false` | no auto-detected URL/e-mail links (`EngineMupdf.cpp:3740`) | **no** — native engine flag |
| `UseSysColors` | `false` | `false` | "use Windows system colors" (`LightPDF.cpp:10978`) | n/a — and note: light-pdf reads it at exactly one place (`WM_SYSCOLORCHANGE`) and never applies it to the document, so the documented behaviour does not exist in the reference either |
| `UseTabs` | `true` | `true` | tabs vs separate windows (`LightPDF.cpp:148`) | n/a |
| `TabsMru` | `false` | `false` | `Ctrl+Tab` in MRU order (`CommandPaletteCollect.cpp:309`) | n/a — the app owns tab switching |
| `ZoomLevels` | *(empty)* | *(empty)* | replaces the built-in zoom ladder (`DisplayModel.cpp:1746-1758`) | **yes** — `pdf.zoomLevels`, read by `nextZoomStep` from both the wheel path and the zoom commands |
| `ZoomIncrement` | `0` | `0` | percent-relative zoom step (`DisplayModel.cpp:1720`) | **yes** — `pdf.zoomIncrement`, same two call sites |
| `CustomScreenDPI` | `0` | `0` | screen DPI for zoom/page sizing (`LightPDF.cpp:1705`) | n/a — the browser reports DPI; the render scale guard is `LIGHTPDF_MAX_RENDER_SCALE` (§9) |
| `DefaultPasswords` | *(unset)* | *(unset)* | passwords tried before prompting (`LightPDF.cpp:597-598`) | **no** — `pdfOpen(path, password?)` exists but no UI stores remembered passwords |
| `UiLanguage` | *(unset)* | `en` | UI language (`AppSettings.cpp:324`) | n/a — `general.language` |
| `VersionToSkip` | *(unset)* | — | update prompt (`gen-settings.ts:955`) | n/a — **and light-pdf never reads it** (no consumer in `src/`) |
| `WindowState` / `WindowPos` | `1` / `0 0 0 0` | `1` / `566 0 788 1020` | window geometry (`LightPDF.cpp:2289`) | n/a |
| `SearchUIWindowPos` | `0 0 0 0` | `0 0 0 0` | floating find window position (`FindWindow.cpp:762`) | n/a |
| `FileStates` | `[]` | `[]` | per-file state: display mode, page, zoom, rotation, scroll pos, `ShowToc`, `BgCol`, favourites, `TocState` (`AppSettings.cpp:430`, `LightPDF.cpp:1629-1678`) | **partly** — `lightpdf-viewstate.ts` keeps display mode, page, scroll (page space), zoom, rotation in memory; `ShowToc`/`Favorites`/`BgCol`/`TocState` are not persisted |
| `SessionData` | `[]` | `[]` | last session's tabs (`LightStartup.cpp:2274-2286`) | n/a |
| `ReopenOnce` | *(unset)* | — | reopen after auto-update (`gen-settings.ts:971`) | n/a — **never read anywhere in light-pdf either** |
| `TimeOfLastUpdateCheck` | `0 0` | `0 0` | update-check throttle (`UpdateCheck.cpp:217`) | n/a |
| `OpenCountWeek` | `0` | `810` | ages `FileStates.OpenCount` (`AppSettings.cpp:339-340`) | n/a |
| `PropWinPos` | `0 0` | `0 0` | properties window position (`LightProperties.cpp:956`) | n/a — the properties dialog is centred |
| `CheckForUpdates` | `true` | `true` | daily update check (`UpdateCheck.cpp:210`) | n/a |
| `AIChatSidebarDx` | `0` | `0` | AI chat sidebar width (`AIChatCommon.cpp:596`) | n/a |

### 1.2 Struct and array settings

| setting | sub-fields (default) | Eukolia |
|---|---|---|
| `FixedPageUI` | `TextColor #000000`, `BackgroundColor #ffffff`, `SelectionColor #ffff00`, `WindowMargin 2 4 2 4`, `PageSpacing 4 4`, `GradientColors` (unset), `WindowBgCol` (unset) | `SelectionColor` → **yes** (`pdf.selectionColor`, plus `pdf.selectionAlpha` for `kSelectionDefaultAlpha`). `WindowBgCol` → **yes** (`pdf.windowBackgroundColor`). `WindowMargin`/`PageSpacing` → **yes** (`pdf.windowMargin`, `pdf.pageSpacing`, in light-pdf's own space-separated form). `TextColor`/`BackgroundColor` → **no** (they substitute the two page colours; needs the engine's colour substitution, i.e. a native build — §7). `GradientColors` → **no** (experimental canvas gradient, `Canvas.cpp:2028`) |
| `EBookUI`, `ComicBookUI`, `ImageUI`, `ChmUI`, `MarkdownUI` | font/layout/CSS per non-PDF document kind | n/a — Eukolia's viewer is a PDF viewer. `ComicBookUI.CbxMangaMode` (right-to-left) is the one portable idea; `lightPdfLayout` accepts `displayR2L` but the pane never sets it → **no** (a reader-facing manga toggle is unimplemented) |
| `ForwardSearch` | `HighlightOffset 0`, `HighlightWidth 15`, `HighlightColor #6581ff`, `HighlightPermanent false` | **yes** — all four are settings (`pdf.forwardSearchHighlight*`) and all four are honoured when the mark is painted; `pdf.highlightSyncPosition` is Eukolia's own on/off on top |
| `PrinterDefaults` | `PrintScale shrink`, `Collate default` | n/a — no printing |
| `Fullscreen` | `ShowToolbar false`, `ShowMenubar false` | n/a — no presentation/fullscreen mode in the renderer |
| `Annotations` | `HighlightColor #ffff00`, `UnderlineColor #00ff00`, `SquigglyColor #ff00ff`, `StrikeOutColor #ff0000`, `FreeTextOpacity 100`, `FreeTextSize 12`, `FreeTextBorderWidth 1`, `SelectionToolbar true`, `TextIconType`, `DefaultAuthor` | **no** — annotations are entirely unimplemented in Eukolia (see §4) |
| `ExternalViewers` | array of `{CommandLine, Name, Filter, Key, ToolbarText, ToolbarSvgIcon}` | n/a — "open in Acrobat/Foxit/…" has no meaning inside an editor pane; Eukolia's `showItemInFolder` covers "Show in folder" |
| `SelectionHandlers` | array of `{URL, Name, Key}` — context-menu actions on the selection | **no** — no canvas context menu in the pane (§4) |
| `Shortcuts` | array of `{Cmd, Key, Name, ToolbarText, ToolbarSvgIcon}` — user key bindings and toolbar buttons | **partly** — `keyboard.customBindings` is Eukolia's equivalent mechanism, and the palette is the discovery surface; light-pdf's "custom toolbar button" half is not implemented |
| `Themes` | array of `{Name, TextColor, BackgroundColor, ControlBackgroundColor, LinkColor, ColorizeControls}` | **partly** — the built-in theme table is ported (`lightpdf-theme.ts` parses `Themes [ … ]` verbatim); user-defined themes are not offered |
| `TabGroups` | array of `{Name, TabFiles}` | n/a |

### 1.3 The Options dialog, for completeness

light-pdf's Options dialog has **8 widgets / 3 group boxes** (`LightDialogs.cpp:850-932`,
template `LightPDF.rc:148-173`): Default Layout, Default Zoom, "Show the bookmarks sidebar
when available", "Remember these settings for each document", "Use tabs", "Automatically
check for updates", "Remember opened files", and the inverse-search command line. Every other
setting is reachable only through the generated Advanced Settings list, and the arrays and
compact structs (`ZoomLevels`, `WindowMargin`, `PageSpacing`, `Themes`, `Shortcuts`,
`SelectionHandlers`, `ExternalViewers`, …) have **no UI at all** — they are hand-edited in
`LightPDF-settings.txt` (`AdvancedSettingsDialog.cpp:237-240`). Eukolia's Settings UI is
therefore strictly richer than light-pdf's; the gap is in which settings exist, not in how
they are edited.

---

## 2. Commands

light-pdf declares 249 commands (`cmd/gen-commands.ts`, ids `201…449`), every one reachable
from the command palette (`CommandPaletteCollect.cpp:330-348`). Eukolia's viewer now
transcribes **58** of them in `lightpdf-commands.ts`.

### 2.1 Implemented in this round (new)

| command | id | key | what it does |
|---|---|---|---|
| `CmdSinglePageView` | 218 | `Ctrl+6` (+numpad) | single-page layout |
| `CmdFacingView` | 219 | `Ctrl+7` (+numpad) | facing layout |
| `CmdBookView` | 220 | `Ctrl+8` (+numpad) | book view |
| `CmdToggleToolbar` | 231 | `F8` | pinned ↔ hidden toolbar (`pdf.toolbar`) |
| `CmdToggleBookmarks` | 225 | `F12` | bookmarks sidebar for the open document |
| `CmdToggleLinks` | 338 | — | `ShowLinks` rectangles (`pdf.showLinks`) |
| `CmdZoomFitByOrientation` | 278 | — | fit width in landscape, else fit page |
| `CmdZoomShrinkToFit` | 293 | — | fit page, never above 100 % |
| `CmdZoomCustom` | 294 | `Ctrl+Y` | "Magnification:" prompt (light-pdf's `Dialog_CustomZoom`) |
| `CmdFindNextSel` | 267 | `Ctrl+F3` | search for the selection |
| `CmdFindPrevSel` | 268 | `Ctrl+Shift+F3` | search backwards for the selection |
| `CmdCopyFilePath` | 248 | — | copy the document path |
| `CmdCopySelection` | 234 | `Ctrl+C`, `Ctrl+Insert` | `Ctrl+Insert` added |
| `CmdReloadDocument` | 214 | `R` | reload from disk |
| `CmdProperties` | 217 | `Ctrl+D` | document properties window |

All fifteen are also registered in the application's command palette (`App.tsx`), dispatched
through the pane's one command table, which is how light-pdf's single `Cmd*` switch works.

### 2.2 Missing commands, grouped by why

**Needs a change in `PdfViewer.tsx`** (the file another agent owns this round; §8): **none — all
four are done.** `CmdChangeScrollbar` (232), `CmdStartAutoScroll` (427),
`CmdToggleCursorPosition` (365); `CmdDebugTogglePredictiveRender` is the one that remains, because
Eukolia has no predictive-render chain to toggle (§4.11).

**Needs a feature Eukolia does not have** (see §4): the annotation commands (270–274,
299–341, 444, 248…), `CmdFavoriteAdd`/`Del`/`Toggle`/`GoToNext/PrevFavorite` (335–337,
435–436), `CmdToggleShowAnnotations` (339), `CmdPrint` (209), `CmdReadAloud` (416) and its
pause/continue/stop/selection variants, `CmdPresentationWhite/BlackBackground` (228–229),
`CmdTogglePresentationMode` (230), `CmdToggleFullscreen` (227), `CmdToggleMangaMode`
(222, R2L), `CmdScreenshot`/`CmdCropImage`/`CmdResizeImage`/`CmdSaveImage`, the PDF
toolbox (`CmdPdfCompress` … `CmdPdfDecrypt`), `CmdDocumentExtractText`,
`CmdCopyImage` (245), `CmdCopyLinkTarget` (246), `CmdCopyComment` (247),
`CmdShowInFolder` (210, Eukolia has this at the application level),
`CmdTranslateSelection*`, `CmdSearchSelectionWith*`, `CmdSelectionHandler`.

**Belongs to the application shell**: `CmdOpenFile` (implemented), `CmdClose`/`CmdCloseCurrentDocument`/
`CmdCloseAllTabs`/… , `CmdNewWindow`, `CmdSaveAs`, `CmdExit`, `CmdOptions`/`CmdAdvancedSettings`,
`CmdChangeLanguage`, `CmdCheckUpdate`, `CmdHelp*`, `CmdNextTab`/`CmdPrevTab`/`CmdMoveTab*`,
`CmdReopenLastClosedFile`, `CmdOpenNextFileInFolder`/`CmdOpenPrevFileInFolder`,
`CmdCommandPalette` (Eukolia's `Ctrl+Shift+P`), `CmdShowLog`/`CmdShowErrors`,
`CmdTabGroupSave`/`Restore`, `CmdSetTheme`/`CmdChangeTheme` (Eukolia's theme list),
`CmdSetDocumentColorsFollowTheme` (the setting exists; the dialog does not),
`CmdToggleLightDarkTheme` (445 — Eukolia's `general.theme`), `CmdExpandAll`/`CmdCollapseAll`/
`CmdExpandToCurrentPage` (316/317/426 — present in the bookmarks sidebar's own context menu),
`CmdCommandPaletteTOC` (423), `CmdNavigateFilesInFolder` (440).

**Windows-only / third-party integration**: the `CmdOpenWith*` family (Explorer, Directory
Opus, Total Commander, Acrobat, Foxit, PDF-XChange, XPS viewer, HTML Help),
`CmdSendByEmail`, `CmdCreateShortcutToFile`, `CmdRenameFile`/`CmdDeleteFile`,
`CmdToggleWindowsPreviewer`/`CmdToggleWindowsSearchFilter`, `CmdListPrinters`,
`CmdInvokeInverseSearch` (Eukolia's built-in SyncTeX), the three `CmdAIChatWith*` commands and
`CmdDebug*`.

---

## 3. Keyboard

light-pdf's built-in table is `gBuiltInAccelerators[]`, `Accelerators.cpp:171-315`: 116 active
entries plus 4 commented out. The port now covers 62 bindings. The table is keyed by *virtual
key*, and a bare letter is the unshifted key, which is why light-pdf needs two entries when
both `a` and `Shift+A` must work (`Accelerators.cpp:288-294`) and why `Shift+I` can mean
"Invert Colors" while `I` means "Toggle Page Info" (`:296-297`).

Covered today (`lightpdf-keyboard.ts`): `j k h l` + arrows, `Shift+Up/Down` (half page),
`Shift+Left/Right` (page), `Space`/`Enter`/`PageDown`/`Ctrl+Down` (page down) and their
inverses, `n`/`p`, `Home`/`End` (+`Ctrl`), `g`/`Ctrl+G`, `Backspace`/`Shift+Backspace`,
`Alt+Left`/`Alt+Right`, `Ctrl+O`, `Ctrl+0/1/2/3`, `Ctrl+Y`, `Ctrl+=`/`Ctrl+-`/`Ctrl++`,
`Ctrl+Shift+=`/`-`, `[`/`]`, `Ctrl+6/7/8`, `Ctrl+F`, `F3`/`Shift+F3`/`Ctrl+F3`/`Ctrl+Shift+F3`,
`Ctrl+A`, `Ctrl+C`/`Ctrl+Insert`, `c`, `z`, `i`/`Shift+I`, `F8`, `F12`, `r`, `Ctrl+D`.

Not bound, and why:

| binding | command | why not |
|---|---|---|
| `Left`/`Right` | `CmdPrevTab`/`CmdNextTab` (`:179-180`) | tabs are the shell's; the pane must not steal the arrows |
| `Ctrl+PageUp`/`Ctrl+PageDown`, `Ctrl+Tab`, `Ctrl+Shift+Tab` | tab switching | shell |
| `Alt+Down`, `Ctrl+W`, `Ctrl+F4`, `Q` | close document (`:178`, `:220`, `:265`, `:301`) | closing a tab is the shell's; the pane follows the build |
| `Ctrl+N`, `Ctrl+Shift+N`, `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+P`, `Ctrl+Q`, `Ctrl+K`, `Ctrl+B`, `F2`, `F1`, `F6` | window/file/palette/print/help (`:216-286`) | the shell owns these keys (notably `Ctrl+B` is Eukolia's Build, where light-pdf uses it for "Add to favorites") |
| `F5`, `Ctrl+L`, `Shift+F11`, `F11`, `Shift+Ctrl+L`, `F` | presentation/fullscreen (`:269-273`, `:304`) | needs a renderer fullscreen path; Electron exposes only a menu role today (§8) |
| `W`, `.`, `b` | presentation white/black background (`:310`, `:313`, `:6244-6246`) | only meaningful inside presentation mode |
| `A`/`Shift+A`, `U`/`Shift+U`, `Ctrl+Delete` | annotation create/delete (`:290-299`) | annotations unimplemented |
| `Ctrl+V` | paste clipboard image (`:230`) | unimplemented (Eukolia pastes into the editor) |
| `M` | `CmdToggleCursorPosition` (`:309`) | the pane has no cursor-position indicator |
| `Alt+L` | collapse window (`:274`) | Windows-only |
| `Shift+Ctrl+T`, `Shift+Ctrl+Left/Right` | reopen last closed / next-prev file in folder (`:217-218`, `:279`) | shell |
| `F9` | toggle menu bar (`:268`) | no Win32 menu bar |
| `Ctrl+Shift+S` | save annotations (`:237`) | annotations |

One structural difference worth recording: light-pdf picks a *restricted* accelerator table
when an edit box or the bookmarks tree has focus (`isSafeAccel`, `Accelerators.cpp:625-664`),
so bare letters never fire while typing. Eukolia gets the same effect from the pane's
keydown handler, which ignores events whose target is an `input`/`textarea`/contenteditable.

---

## 4. Features the viewer still lacks

These are light-pdf capabilities rather than settings; each is a real gap, not a dropped
toggle.

1. **Annotations** (create/select/edit/delete, `CmdCreateAnnot*`, `CmdEditAnnotations`,
   `CmdSaveAnnotations`, `Annotations.*` defaults, the floating selection toolbar
   `Annotations.SelectionToolbar`). Nothing in Eukolia writes back into a PDF, so the whole
   area — including "Save Annotations to existing PDF" — is absent.
2. **Favorites** (per-document page bookmarks: `CmdFavoriteAdd`/`Del`/`Toggle`, the sidebar
   list, `FileState::Favorites`). The bookmarks *tree* exists now; the favourites *list* does
   not.
3. **Canvas context menu** (`menuDefContext`, `Menu.cpp:984-1082`) — Copy Selection, the
   Selection submenu (translate/search), Copy Link Address, Save/Open Attachment, Show
   Favorites/Bookmarks/Toolbar, Save Annotations. The pane has no context menu at all.
4. **Printing** (`CmdPrint`, `PrinterDefaults`) — no print pipeline.
5. **Read Aloud / TTS** (`CmdReadAloud` and the seven related commands, `ReadAloudSpeed`,
   `ReadAloudVoiceId`) — no text-to-speech.
6. **Presentation mode and fullscreen** (`DisplayModel::SetInPresentation`,
   `DM:1432-1459`; black/white backgrounds; click-to-turn pages; 3 s cursor auto-hide;
   `Fullscreen.*`; `PreventSleepInFullscreen`).
7. **Selection handlers and translate/search services** (`SelectionHandlers`,
   `CmdTranslateSelection*`, `CmdSearchSelectionWith*`) — light-pdf's "act on the selection"
   menu. Eukolia has `openExternal`, so these are implementable.
8. **Attachments and embedded files** (`CmdOpenAttachment`, `CmdSaveAttachment`,
   `CmdSaveEmbeddedFile`, `CmdOpenEmbeddedPDF`).
9. **PDF toolbox** (`CmdPdfCompress`/`Decompress`/`DeletePages`/`ExtractPages`/`Encrypt`/
   `Decrypt`/`Bake`, `CmdDocumentExtractText`, `CmdScreenshot`/`CmdCropImage`/`CmdResizeImage`/
   `CmdSaveImage`/`CmdConvertImageToPdf`, `CmdChangeBackgroundColor` for a single file).
10. **Search UI variants**: the floating results window (`SearchUIFloating`,
    `FindWindow.cpp`) and match-case in the floating window. Whole-word search is **done**
    (`CmdFindToggleMatchWholeWord`, 434): the engine already supported it
    (`worker_main.cpp:1155`, `pdfHandler.ts:345`) and the find bar already had the button
    (`LIGHTPDF_FIND_BAR_BUTTONS`) — the option now travels from the bar through
    `PdfViewerHandle.find(query, { wholeWord })` to the engine. Note it is deliberately **not** a
    setting: light-pdf keeps the flag in the find window, not in `LightPDF-settings.txt`, so a
    `pdf.findWholeWord` key would be a control the reference does not have.
11. **Predictive rendering chain** (`DisplayModel::RenderVisibleParts`, `DM:1181-1242`: up to
    4 pages, ±1, ±2 in two-column modes, re-requested last→first) — Eukolia prefetches by
    distance (`pdf.renderAheadPages`) but has no chain and no tile cache
    (`MAX_PAGE_REQUESTS`/`MAX_BITMAPS_CACHED`, `RenderCache.h`).
12. **Home page / frequently read / thumbnails** (`ShowStartPage`, `HomePage*`,
    `FileThumbnails.cpp`) — application-level in Eukolia.
13. **Manga mode / right-to-left rows** (`ComicBookUI.CbxMangaMode`, `CmdToggleMangaMode`) —
    `lightPdfLayout` already accepts `displayR2L`, but nothing sets it.
14. **Passwords**: light-pdf remembers `DecryptionKey`/`DefaultPasswords`; Eukolia's
    `pdfOpen` accepts a password but no UI stores one.
15. **`ShowLinks` detail**: light-pdf's `DebugShowLinks` outlines *every* non-image page
    element, not only link destinations (`Canvas.cpp:1846-1856`). Eukolia's view outlines the
    link rectangles, which is what the setting is for, and is the closest thing the frozen
    contract exposes.

## 5. Toolbar and chrome

light-pdf's `gToolbarButtons[]` (`Toolbar.cpp:69-89`) is ported entry for entry, including
the separators and the page-number box (`LightPdfToolbar.tsx`). Differences:

- `CmdPrint` and `CmdReadAloud` keep their slots but render nothing, exactly as
  `IsCmdAvailable` + `TBSTATE_HIDDEN` behave when a command is unavailable. There is no zoom
  percentage box in light-pdf either (verified: `Toolbar.cpp:69-89, 1036-1082`), so none was
  added.
- Custom toolbar buttons from the `Shortcuts` array (`PopulateCustomToolbarButtons`,
  `Toolbar.cpp:1125-1174`) are not implemented.
- Tooltips append the accelerator, as `UpdateToolbarButtonsToolTipsForWindow`
  (`Toolbar.cpp:318-365`) does.
- The find bar is `FindBar.cpp`'s bar: edit with the cue "Find", the `n / m` status, prev/next
  and match case. The whole-word button and "Open in a window" are the two that are missing
  (see §4.10).

---

## 6. What is deliberately out of scope, and why

Not dropped quietly — each is a decision:

- **Installer, file associations, shell integration, single instance** (`ReuseInstance`,
  `CmdCreateShortcutToFile`, `CmdSendByEmail`, the `CmdOpenWith*` family): the platform's job,
  and an Electron app that owns its own window cannot honour them from the renderer.
- **Printing** (`CmdPrint`, `PrinterDefaults`): Eukolia has no print pipeline; Electron's
  `webContents.print` prints the *editor window*, not the PDF page model.
- **Tabs, sessions, the home page, recent files, favourites menus** (`UseTabs`, `TabsMru`,
  `TabWidth`, `SessionData`, `FileStates`, `HomePage*`, `ShowStartPage`, `ShowTips`,
  `NoHomeTab`, `TabGroups`, `ReopenOnce`): Eukolia is an editor with one PDF pane per
  workspace; the shell already owns session restore and file history.
- **Windows chrome** (`WindowState`, `WindowPos`, `SearchUIWindowPos`, `PropWinPos`,
  `EnableCollapseShortcut`, `ShowMenubar*`, `FullPathInTitle`, `EscToExit`, `UIFontSize`): the
  Electron window and Eukolia's own title bar/menu own these.
- **Non-PDF document kinds** (`EBookUI`, `ComicBookUI`, `ImageUI`, `ChmUI`, `MarkdownUI`,
  `CmdConvertImageToPdf`): the pane renders PDFs.
- **AI chat sidebars** (`ClaudeCode`, `GrokBuild`, `CodexBuild`, `AIChatSidebarDx`,
  `TranslateToLang/FromLang/Engine`): unrelated to a LaTeX editor's PDF view.
- **Update checking** (`CheckForUpdates`, `TimeOfLastUpdateCheck`, `VersionToSkip`): the app
  ships as an Electron bundle. (light-pdf itself never reads `VersionToSkip`.)
- **`UseSysColors`**: out of scope *and* inert in the reference — light-pdf reads it only in
  its `WM_SYSCOLORCHANGE` handler (`LightPDF.cpp:10978`) and never applies it to a page.
- **Thumbnail cache on disk** (`FileThumbnails.cpp`): light-pdf's home page feature.

---

## 7. What we cannot support through Eukolia's frozen contracts

These are honest "no"s with the exact blocker, so nobody ships a dead control for them:

| light-pdf setting/feature | blocker |
|---|---|
| `FixedPageUI.TextColor` / `BackgroundColor` (page colour substitution) | the engine substitutes black/white *inside* MuPDF's render; Eukolia's `pdfRender` contract exposes only `invert` (`src/shared/ipc.ts:192-205`), which is a whole-pixmap `fz_invert_pixmap` (`mupdf_engine.cpp:785-789`) = light-pdf's `legacy`. Adding the two colours means a new native field and a native build |
| `DisableAntiAlias`, `EngineeringDrawingEnhance`, `DisableAutoLinks`, `AllowExternalImages`, `DisableJavaScript` | native engine flags (`EngineMupdf.cpp:4095-4100`, `PdfCadDetect.cpp:20-28`, `EngineMupdf.cpp:3740`, `EngineMupdf.cpp:3084-3088`, `EngineMupdf.cpp:3275-3283`); same reason |
| `CitationHoverDelay` (link hover popup) | needs a *region* render and a popup window; the contract renders whole pages |
| `SearchUIFloating` (floating find window with a results list) | `pdfSearch` returns `{page, rects}` only (`src/shared/ipc.ts:275-277`) — no result text, so a results list cannot be drawn. Adding text to the wire format is a main-process change |
| `Annotations.*`, `CmdSaveAnnotations*` | Eukolia has no PDF write path at all |
| Printing, TTS, presentation/fullscreen | no renderer API; `togglefullscreen` exists only as a native menu role (`src/main/main.ts:254`) |
| `Shortcuts` custom toolbar buttons | the SVG icon and text would have to come from settings into `LightPdfToolbar`; possible, but the palette already covers command discovery |

---

## 8. Changes that need `PdfViewer.tsx` (the file owned elsewhere this round)

**Status: every item below is now done.** They are kept here as the record of what the viewer had
to grow, and of the reasons each one was a viewer change rather than a settings change. The notes
that follow each entry say what was actually done and what it cost.

Every one of these is a two-line change *inside* the file, and each is listed here rather than
made, so it can be sequenced:

1. **`pdf.scrollSensitivity`** (`ScrollSensitivity`, default 2.0): the wheel handler uses the
   constant `SCROLL_SENSITIVITY` (`PdfViewer.tsx:217`, used at `:1473`, `:1483`). Replace with
   `setting.num('pdf.scrollSensitivity')`.
2. **`pdf.scrollbar`** (`Scrollbars`: windows/smart/overlay/hidden): the scroller always hides
   the native bar (`PdfViewer.tsx:2096-2101`) and always renders `OverlayScrollbar` in `Smart`
   mode (`:2292`). Wire the mode: `overlay` → `mode="Thick"`, `hidden` → no overlay *and* keep
   the native bar suppressed, `windows` → native bar visible and no overlay.
3. **`pdf.scrollbarInSinglePage`** (`ScrollbarInSinglePage`): in single-page mode the bar
   becomes a page slider (`Canvas.cpp:642, 653-693, 3200-3202`).
4. **`pdf.fastScrollOverScrollbar`** (`FastScrollOverScrollbar`): one wheel notch becomes half
   a page when the pointer is over the scrollbar strip (`Canvas.cpp:2718-2728`).
5. **`pdf.smoothScroll` / `pdf.smoothScrollFriction`**: light-pdf's integrator is
   `velocity -= impulse` then `v *= exp(-friction*50*dt)` with a 5 px/s stop
   (`Canvas.cpp:2259-2313`, `:2730-2750`). Eukolia scrolls through the shared smooth-scroll
   helper; exposing light-pdf's two values means implementing the impulse model in the wheel
   handler.
6. **`pdf.zoomLevels` / `pdf.zoomIncrement`** (`ZoomLevels`, `ZoomIncrement`): `nextZoomStep`
   in `lightpdf-layout.ts` already takes the ladder from `LIGHTPDF_ZOOM_LEVELS`; the wheel
   path (`stepZoom`) and the handle's `zoomStep` are inside `PdfViewer.tsx`. Until both read
   the settings, a ladder setting would change the toolbar buttons but not Ctrl+wheel — which
   is why it is **not** in the schema yet.
7. **`pdf.windowMargin` / `pdf.pageSpacing`** (`FixedPageUI.WindowMargin`, `PageSpacing`):
   `LIGHTPDF_WINDOW_MARGIN` / `LIGHTPDF_PAGE_SPACING` are read at `PdfViewer.tsx:202-203` and
   passed to `lightPdfLayout`. Both are `Int`/compact settings in light-pdf; as Eukolia
   settings they would be four numbers and two numbers (the schema has `array`, and
   `compilation.extraArgs` is precedent).
8. **`pdf.selectionToolbar`** (`Annotations.SelectionToolbar`, default **true**): light-pdf
   pops a small floating toolbar (Copy / Translate / Read Aloud / Highlight / Underline /
   Squiggly / Strike Out, `SelectionToolbar.cpp:61-84`) after a selection. Eukolia has no
   annotation actions, so only Copy would be real; it needs the selection state that lives in
   `PdfViewer.tsx`.
9. **`pdf.findWholeWord`** (`CmdFindToggleMatchWholeWord`, `CmdFindToggleMatchCase`'s
   sibling): the engine and the main process already support it
   (`pdfHandler.ts:324, 345`; `worker_main.cpp:1155`) and the find bar already has the button
   (`LIGHTPDF_FIND_BAR_BUTTONS`). The only missing link is
   `PdfViewerHandle.find(query, { wholeWord })` — the preload's type also needs
   `wholeWord?: boolean` (`preload.ts:166`), which is my file to change if you prefer.
10. **`pdf.forwardSearchHighlightColor` / `HighlightWidth` / `HighlightOffset` /
    `HighlightPermanent`**: the SyncTeX highlight is drawn from constants
    (`PdfViewer.tsx:2270`).
11. **`CmdStartAutoScroll`** (427): middle-click auto-scroll exists
    (`PdfViewer.tsx:1728-1729`, `startAutoScroll`), but there is no handle method, so the
    command cannot be reached from the palette or a key.
12. **`CmdToggleCursorPosition`** (365) and **`CmdChangeScrollbar`** (232): the latter follows
    from §8.2; the former needs a cursor-position indicator that does not exist.

Everything in this list is *not* in the settings schema: a control that does nothing is worse
than an absent one, and each of these needs the viewer change first.

### 8.1 What the viewer changes turned out to be

| # | setting / command | what it needed |
|---|---|---|
| 1 | `pdf.scrollSensitivity` | read live from `setting.num` (`wheelSettingsRef`). |
| 2 | `pdf.scrollbar` | `windows` leaves the native bar; `smart`/`overlay` suppress it and draw the overlay; `hidden` suppresses it and draws nothing. `CmdChangeScrollbar` (232) picks between the four. |
| 3 | `pdf.scrollbarInSinglePage` | in `single-page` the bar's position *is* the page number (`pageSliderRef`), so `scrollToOffset` writes `page - 1`. |
| 4 | `pdf.fastScrollOverScrollbar` | half a page per notch while the pointer is right of the client box. |
| 5 | `pdf.smoothScroll` / `pdf.smoothScrollFriction` | **done, and it needed a `pdf.smoothScroll` key**: light-pdf's `SmoothScroll` had no Eukolia key, so the integrator was gated on the app-wide `scrolling.smooth` instead (see §1.1). |
| 6 | `pdf.zoomLevels` / `pdf.zoomIncrement` | both the wheel path and the handle's `zoomStep` read them through `zoomSettingsRef`. |
| 7 | `pdf.windowMargin` / `pdf.pageSpacing` | parsed from light-pdf's space-separated form and fed to `lightPdfLayout`. |
| 8 | `pdf.selectionToolbar` | the card exists; only the commands Eukolia implements are drawn (`SelectionToolbar.cpp:61-69` lists seven, one of which — Copy — is real here). |
| 9 | `pdf.findWholeWord` | **deliberately not added.** light-pdf has no `GlobalPrefs` key for it: `FindBar.cpp` keeps the flag in the find window, not in `LightPDF-settings.txt`. The option travels from the bar to `PdfViewerHandle.find` and on to the engine's `SetMatchWholeWord`, and it lives in the pane's state as light-pdf's lives in its find window's. A settings key would be a control the reference does not have. |
| 10 | `ForwardSearch.*` | all four values (`HighlightColor`, `HighlightWidth`, `HighlightOffset`, `HighlightPermanent`) are settings and are honoured when the mark is painted. |
| 11 | `CmdStartAutoScroll` | the handle exposes `toggleAutoScroll`; palette and keys reach it. |
| 12 | `CmdToggleCursorPosition` (365) | the tip exists with light-pdf's own pt → mm → in → off cycle (`LightPDF.cpp:6323-6356`). `CmdChangeScrollbar` follows from §8.2. |

### 8.2 What is still a gap, and why it is not a setting

Nothing in §8 is left. What remains unconfigurable is unconfigurable for one of three reasons, and
none of them is a missing control:

- **a feature with no renderer API**: annotations (nothing in Eukolia writes back into a PDF),
  printing, read-aloud, presentation/fullscreen, favourites, the floating find window, the
  predictive-render chain, attachments — §4 and §6.
- **a native engine flag**: `FixedPageUI.TextColor` / `BackgroundColor` (the page colour
  substitution happens inside MuPDF's render), `DisableAntiAlias`, `EngineeringDrawingEnhance`,
  `DisableAutoLinks`, `AllowExternalImages`, `DisableJavaScript` — §7.
- **a shell concern**: window chrome, tabs, sessions, the home page, update checking,
  `SelectionHandlers` (which act on a canvas context menu the pane does not have), the
  `Shortcuts` custom toolbar buttons — §6.

The one Eukolia-side gap worth naming is the **canvas context menu** (`Menu.cpp:984-1082`), which
is the missing half of the selection feature: light-pdf's selection menu is the `SelectionHandlers`
array *plus* a fixed set of commands (Copy Selection, Copy Link Address, Show Favorites/Bookmarks/
Toolbar), and the pane has neither. It is a feature rather than a setting, and it is not attempted
here because a menu with one live entry and six dead ones is the shape this document exists to
prevent.

---

## 9. Render fidelity: the scale, the blit, the fonts and the page box

light-pdf has no render-scale preference, and for a structural reason: it rasterises only the
**tiles on screen** (`RenderCache.h:34-50`, `RenderVisibleParts`, `DisplayModel.cpp:1181-1242`),
so the picture is always as sharp as the display however far the reader zooms. Eukolia's engine
renders a **whole page** per request, so an unbounded scale turns a high zoom of a large page
into a multi-gigapixel allocation.

`pdf.devicePixelRatioCap` was the answer to that, and it was the wrong shape: at its default of
4 the engine was asked for fewer device pixels than the page occupied from 400 % zoom on a
100 %-scale display (320 % on 125 %), and `paint`'s `drawImage(bitmap, 0, 0, width, height)`
stretched the smaller bitmap across the sheet. A page that is sharp until you zoom in and softens
after is precisely the defect class this port is meant to remove, so the setting is **removed**
from `settings.ts` and the viewer now asks for the scale the display actually needs
(`zoomReal × devicePixelRatio`).

What remains is a whole-page **allocation guard**, not a preference:
`LIGHTPDF_MAX_RENDER_SCALE = 16` device pixels per point — 1600 % zoom on a 100 %-scale display
and 800 % on a 200 % one, against light-pdf's own `kZoomMax` of 6400 %. It cannot bind in normal
reading, and when it does bind the pane says so (`data-render-scale-constrained` on the scroller
and the render-scale notice in `PdfPane`) instead of showing a quietly softer page.

Memory is bounded where it belongs: `pdf.maxCachedPages` (page cache) and `pdf.renderAheadPages`
(prefetch window), which is what those two settings are for.

### 9.1 The blit, which the scale alone does not fix

Asking for the right scale is only half of "the page is displayed 1:1". The other half is the box
the canvas is displayed in, and it is the subtler half because nothing about it looks wrong: the
engine rounds the page's device box **outward** (`fz_round_rect`: `floor(x0)`, `ceil(x1)`) so it
never clips content, while the layout rounds the sheet to a fraction of a CSS pixel. A sheet of
544.025 CSS px at a ratio of 1.25 is a 680.031-pixel box that the engine renders as **681**
pixels; a canvas displayed at the sheet's size is therefore a 0.9986 rescale of its own backing
store, and the compositor filters the whole page.

Measured in the running application, by comparing a screenshot of the page against the canvas's
own pixels (mean absolute luminance step over one fixed patch of text): one pixel of mismatch
over a 700-pixel page — 0.14 % — cost **25 %** of the edge energy and **half** the hard glyph
edges. `canvasDisplayBox` sizes the canvas from the bitmap (`width / devicePixelRatio`), which is
exactly the backing store in device pixels by construction, whatever rounding either side chose;
every zoom then measures 1.000, at fractional scroll offsets and fractional device origins alike.
The guard's case keeps the sheet's box, because a bitmap smaller than the display wants must be
stretched rather than shrink the page.

### 9.2 Fonts the document does not embed

light-pdf installs MuPDF's Windows font loader (`EngineMupdf.cpp:2330-2332`), which lives inside
the same `libmupdf.dll` Eukolia links and is exported as `install_load_windows_font_funcs`.
Without it `fz_load_system_font` answers NULL to every name and the document gets one built-in
substitute for all of them — measured: `/BaseFont /SimSun`, `/Calibri` and a nonsense name all
rendered identically (100.656 pt advance, 454 ink pixels). With the call the face comes from the
Windows font directory, as it does in the reference. LaTeX output embeds its fonts, so this
changes nothing for the common case and a great deal for documents that reference system faces
(Office exports, CJK) without embedding them.

### 9.3 The page box for a page with its own `/Rotate`

The worker reports the **rotated** page box — what `pdf_bound_page` returns — because
`fz_run_page` and `fz_new_display_list_from_page` apply the page's own `/Rotate` before anything
else sees the content, so a `/Rotate 90` A4 page occupies 792x612 in the space every coordinate
the worker reports is in. Reporting the unrotated CropBox instead made the clip, the pixmap and
the text extractor's page box disagree with content that had already been rotated: `/Rotate 90`
came back **blank**, `/Rotate 270` lost a strip of the page, both had the wrong aspect, and the
text layer's boxes collapsed to zero size (the glyphs fell outside the box the extractor was
built against), which broke selection and search on exactly those pages.
`tests/pdf/pageRotation.test.ts` pins the box, the ink and the text boxes for all four values.

---

## 10. Summary of the checked-in gap

| area | light-pdf | Eukolia before this round | Eukolia now |
|---|---|---|---|
| `pdf.*` settings keys in the schema | — | 13 | **35**, every one of them read by the pane |
| light-pdf `GlobalPrefs` keys read live | — | 4 (`Theme`, `DefaultDisplayMode`, `DefaultZoom`, `FixedPageUI.SelectionColor`) plus two through Eukolia equivalents (`SmoothScroll` → `scrolling.smooth`, `RememberStatePerDocument` → `lightpdf-viewstate.ts`) | **20**, plus one equivalent (`RememberStatePerDocument` → `lightpdf-viewstate.ts`) — `SmoothScroll` now has its own key |
| transcribed commands | 249 | 42 | 58 |
| transcribed accelerators | 116 active (+4 commented out) | 48 | 62 |
| bookmarks sidebar | yes | no | yes (`ShowToc`, `F12`, expand/collapse/filter) |
| document properties window | yes | no | yes (`Ctrl+D`) |
| toolbar modes (pinned/hidden/overlay), position and icon size | yes | pinned, fixed size | yes |
| link rectangles (`ShowLinks`) | yes | no | yes |
| canvas/page colour preferences | yes | selection colour + alpha | + `WindowBgCol`, `MainWindowBackground`, `DocumentColorsFollowTheme` |
| scrollbars: four modes, page slider in single-page, fast scroll over the bar | yes | one mode, no slider, no fast scroll | yes |
| overlay scrollbars | **two**, one per axis (`LightPDF.cpp:1226`, `:1281`) | one, vertical only | **two** — the horizontal one is what makes a page wider than the pane reachable in `smart`/`overlay` |
| momentum wheel | yes (`SmoothScroll`, `SmoothScrollFriction`) | gated on the app-wide `scrolling.smooth` | yes, `pdf.smoothScroll` + `pdf.smoothScrollFriction` |
| zoom ladder and step | `ZoomLevels`, `ZoomIncrement` | constants | settings, honoured by the wheel and both zoom commands |
| margins and page spacing | `FixedPageUI.WindowMargin`, `PageSpacing` | constants | settings, in light-pdf's own space-separated form |
| SyncTeX marker (colour, width, offset, permanence) | `ForwardSearch.*` | constants | settings |
| selection toolbar | `Annotations.SelectionToolbar` | no | yes (the commands that exist) |
