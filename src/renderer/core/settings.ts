/**
 * Eukolia settings.
 *
 * Implements Instructions.md §56 (categorised, searchable settings with
 * validation, reset-to-default and user/project scopes) and §57 (predictable
 * precedence: Default < User < Workspace).
 *
 * The schema below is the single source of truth: it drives the defaults, the
 * settings UI, search, validation and the configuration bridge that ported
 * VS Code extension code reads through `workspace.getConfiguration`.
 */

import { EventEmitter } from './events';
// `files.autoSave`'s four modes and what each one means live in their own
// module: the schema offers them, the workspace acts on them, and the settings
// row explains them, so the list cannot be edited in one place and forgotten in
// the others.
import {
  AUTO_SAVE_MODE_DESCRIPTIONS,
  AUTO_SAVE_MODES,
  DEFAULT_AUTO_SAVE_MODE
} from './autoSave';
// The built-in themes are enumerated in one place, so the settings list cannot
// fall behind the themes that actually exist.
import { THEME_NAMES } from './themes';
// The PDF viewer's theme list comes from the ported light-pdf theme table, so the
// settings cannot offer a theme the viewer does not have.
import { LIGHTPDF_THEME_NAMES } from '../pdf/lightpdf-theme';
// What a clean removes is one list, shared with the main process that performs
// it, so the schema's default cannot fall behind it.
import { CLEAN_EXTENSIONS } from '../../shared/cleanExtensions';

export type SettingScope = 'default' | 'user' | 'workspace';

export type SettingType = 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'color';

export interface SettingDescriptor<T = unknown> {
  /** Dotted key, e.g. `editor.tabSize`. */
  key: string;
  /** Category shown in the settings UI. */
  category: string;
  /** Human-readable label. */
  label: string;
  type: SettingType;
  default: T;
  /** Allowed values for `enum`. */
  options?: readonly string[];
  /**
   * One sentence per entry of `options`, in the same order, for `enum` rows.
   *
   * VS Code shows these under the dropdown (`enumDescriptions`), and they are
   * what makes a choice like `onFocusChange` answerable without leaving the
   * settings pane.
   */
  optionDescriptions?: readonly string[];
  /** Allowed range for `number`. */
  min?: number;
  max?: number;
  step?: number;
  /** Longer explanation shown under the control. */
  description?: string;
  /** Extra terms that should match this setting in search. */
  keywords?: readonly string[];
  /** The VS Code configuration key this maps to when ported code asks for it. */
  vscodeKey?: string;
  /** Setting requires an application restart, or at least an editor reload. */
  requiresReload?: boolean;
  /**
   * Whether a project's own `.eukolia/settings.json` may set this key.
   *
   * **Absent means no**, which is the rule rather than an omission: most
   * settings are the user's, and the handful that are not are the ones a project
   * genuinely owns. See `canBeProjectScoped`.
   */
  projectScoped?: boolean;
}

export const SETTING_CATEGORIES = [
  'General',
  'Editor',
  'Visual Editor',
  'LaTeX',
  'Compilation',
  'PDF',
  'Snippets',
  'Formatting',
  'Files',
  'Appearance',
  'Scrolling',
  'Keyboard',
  'Advanced'
] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

/**
 * The synthetic section holding the keybinding editor.
 *
 * It sits beside the categories rather than in `SettingsView` because two things
 * need to agree on it and only one of them may import the view: the pane itself,
 * and the shell's Escape handler, which steps back out of a synthetic section
 * before closing the pane. The pane is loaded on demand, so the constant it is
 * matched against cannot live inside it — importing the view to read a string
 * would load the whole settings editor at startup, which is the thing its lazy
 * import exists to avoid.
 */
export const SHORTCUTS_SECTION = 'Keyboard Shortcuts';

/**
 * Which settings a project's own `.eukolia/settings.json` may override.
 *
 * Written as the list of *project* settings rather than the list of user ones,
 * because the answer to "is this the user's or the project's?" is the user's for
 * almost everything and the schema has to say so by default rather than by
 * omission. A project file that names anything else is ignored for that key —
 * not merged, not applied — so a project cannot silently change how the
 * application looks or how the editor behaves for the person opening it, and
 * sharing a project cannot carry a preference nobody agreed to.
 *
 * The rule for what *is* here: the setting changes what the project produces or
 * has to agree with what is already in it, so a value that differs per project
 * is the correct value rather than a surprise —
 *
 *  * **Compilation** — the engine, the recipe, the arguments, the output
 *    directory, the auxiliary files a clean removes. Two projects may need two
 *    toolchains, and a document that needs `-shell-escape` needs it because of
 *    its own content.
 *  * **The root document** — a book's `main.tex` is a property of the book.
 *  * **The snippet directories a project ships** — `snips/` is project content,
 *    and that is why project snippets exist at all.
 *
 * Everything else — the editor, the PDF viewer, the theme, the appearance, the
 * shortcuts, the snippet engine's own switches — is a property of the person
 * using the application and stays theirs whatever they open.
 */
export const PROJECT_SCOPED_SETTINGS: readonly string[] = [
  'latex.rootDocument',
  'compilation.engine',
  'compilation.recipe',
  'compilation.extraArgs',
  'compilation.synctex',
  'compilation.autoBuild',
  'compilation.cleanExtensions',
  'compilation.outputDirectory',
  'compilation.latexmk.minimumRule',
  'snippets.snippetDirectories'
];

const projectScopedKeys = new Set(PROJECT_SCOPED_SETTINGS);

/**
 * Whether a project file may set this key.
 *
 * A key the schema does not declare is **not** project-scoped either: the
 * advanced-settings file exists so keys the schema does not name can be carried
 * (`keybindings.<command>`, an experimental flag), and by the rule above those
 * belong to the user. A project that needs one can still name it in its own
 * file — the renderer ignores it for the *value*, and a reader can see what the
 * project asked for.
 */
export const canBeProjectScoped = (key: string): boolean => {
  const descriptor = schemaByKey.get(key);
  return descriptor ? descriptor.projectScoped === true : false;
};

/** The declared settings a project may override, for documentation and tests. */
export const projectScopedDescriptors = (): SettingDescriptor[] =>
  SETTINGS_SCHEMA.filter((descriptor) => descriptor.projectScoped === true);

const deserialize = <T>(raw: unknown, fallback: T): T => {
  if (raw === undefined || raw === null) return fallback;
  if (Array.isArray(fallback)) return (Array.isArray(raw) ? raw : fallback) as T;
  if (typeof fallback === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return (Number.isFinite(n) ? n : fallback) as T;
  }
  if (typeof fallback === 'boolean') return (typeof raw === 'boolean' ? raw : fallback) as T;
  return raw as T;
};

/**
 * The full Eukolia configuration schema.
 *
 * Keys are grouped by category for the UI; the flat dotted key is what code and
 * config files use.
 */
export const SETTINGS_SCHEMA: readonly SettingDescriptor[] = [
  // ---------------------------------------------------------------- General
  {
    key: 'general.theme',
    category: 'General',
    label: 'Theme',
    type: 'enum',
    // Every built-in theme is listed; the labels come from `THEME_LABELS` so the
    // settings list and the status bar name a theme the same way.
    options: [...THEME_NAMES, 'system'],
    default: 'dark',
    description:
      'Application colour theme. "System" follows the operating system. Themes also drive the editors, the visual preview and the PDF viewer chrome.',
    keywords: ['colour', 'color', 'appearance', 'dark mode', 'light mode', 'solarized', 'nord', 'gruvbox', 'one dark', 'catppuccin']
  },
  { key: 'general.language', category: 'General', label: 'Interface language', type: 'enum', options: ['en'], default: 'en' },
  { key: 'general.restoreSession', category: 'General', label: 'Restore session on startup', type: 'boolean', default: true, description: 'Reopen the previous workspace, tabs, layout and PDF position.' },
  { key: 'general.crashRecovery', category: 'General', label: 'Recover unsaved documents after a crash', type: 'boolean', default: true },
  { key: 'general.confirmExitWithUnsavedChanges', category: 'General', label: 'Confirm exit with unsaved changes', type: 'boolean', default: true },
  { key: 'general.recentWorkspaces', category: 'General', label: 'Recent workspaces to remember', type: 'number', default: 12, min: 0, max: 50 },

  // ----------------------------------------------------------------- Editor
  //
  // Only settings the editor actually reads. Three dead controls were removed
  // when the two editors became one CodeMirror editor: `editor.minimap` and
  // `editor.bracketPairColorization` (CodeMirror has no equivalent of either),
  // and `editor.lineHeight` (the ported Overleaf theme that paints the editor in
  // both modes takes three named line heights — `compact`/`normal`/`wide`, i.e.
  // 1.3/1.5/1.7 — not a 1–3 multiplier, so honouring it would mean changing the
  // ported theme's vocabulary). `editor.semanticHighlighting` went the same way:
  // nothing in the application ever read it, because the colouring it names is
  // what `eukoliaSyntaxHighlighting` already does from the syntax tree.
  { key: 'editor.fontSize', category: 'Editor', label: 'Font size', type: 'number', default: 14, min: 8, max: 40, step: 1 },
  { key: 'editor.fontFamily', category: 'Editor', label: 'Font family', type: 'string', default: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace" },
  { key: 'editor.tabSize', category: 'Editor', label: 'Tab size', type: 'number', default: 2, min: 1, max: 16, step: 1 },
  { key: 'editor.insertSpaces', category: 'Editor', label: 'Insert spaces', type: 'boolean', default: true },
  { key: 'editor.wordWrap', category: 'Editor', label: 'Word wrap', type: 'boolean', default: true },
  { key: 'editor.lineNumbers', category: 'Editor', label: 'Line numbers', type: 'enum', options: ['on', 'off', 'relative'], default: 'on' },
  {
    key: 'editor.renderWhitespace',
    category: 'Editor',
    label: 'Render whitespace',
    type: 'enum',
    options: ['none', 'boundary', 'all'],
    optionDescriptions: [
      'Whitespace is not marked.',
      'Every whitespace character is marked except a single space between two words.',
      'Every space and every tab is marked.'
    ],
    // `none`, not Monaco's `boundary`: a run of two spaces *is* marked by the
    // boundary rule, so a line that has picked up trailing spaces — a pasted
    // `\begin{theorem}`, a filled environment — wore a row of dots in the middle
    // of the source. VS Code, whose setting this is, marks nothing while you
    // read either (its own default, `selection`, only marks inside a selection);
    // the marks are one click away for anyone who wants them.
    default: 'none',
    description: 'Marks spaces and tabs with dots and arrows in the code editor. Off by default; turn it on to see indentation and trailing whitespace.',
    keywords: ['whitespace', 'spaces', 'tabs', 'dots', 'trailing', 'invisible characters']
  },
  { key: 'editor.renderIndentGuides', category: 'Editor', label: 'Indentation guides', type: 'boolean', default: true, description: 'Draw a thin line at every indentation level, as Monaco\u2019s editor.renderIndentGuides did.' },
  { key: 'editor.matchBrackets', category: 'Editor', label: 'Highlight matching brackets and environments', type: 'boolean', default: true },
  { key: 'editor.folding', category: 'Editor', label: 'Code folding', type: 'boolean', default: true },
  {
    key: 'editor.largeFileOptimizations',
    category: 'Editor',
    label: 'Large-file handling',
    type: 'boolean',
    default: true,
    description:
      'Turn off the features that have to look at the whole document once it is large, so that typing stays immediate. The features that are off are named in the editor; turning this off forces them all on, at the cost of the delay they cause.',
    keywords: ['large file', 'performance', 'lag', 'slow'],
    vscodeKey: 'editor.largeFileOptimizations'
  },
  {
    key: 'editor.smartDelimiters',
    category: 'Editor',
    label: 'Smart delimiters',
    type: 'boolean',
    default: true,
    description: 'Master switch for automatically closing delimiters as you type. When enabled, individual delimiter settings below take effect.'
  },
  {
    key: 'editor.autoCloseSquareBrackets',
    category: 'Editor',
    label: 'Auto-close square brackets [ ]',
    type: 'boolean',
    default: true,
    description: 'Automatically insert closing "]" when typing "[".'
  },
  {
    key: 'editor.autoCloseCurlyBraces',
    category: 'Editor',
    label: 'Auto-close curly braces { }',
    type: 'boolean',
    default: true,
    description: 'Automatically insert closing "}" when typing "{".'
  },
  {
    key: 'editor.autoCloseParentheses',
    category: 'Editor',
    label: 'Auto-close parentheses ( )',
    type: 'boolean',
    default: true,
    description: 'Automatically insert closing ")" when typing "(". '
  },
  {
    key: 'editor.autoCloseDollarSigns',
    category: 'Editor',
    label: 'Auto-close math delimiters $ $',
    type: 'boolean',
    default: true,
    description: 'Automatically insert closing "$" when typing "$".'
  },
  {
    key: 'editor.autoCloseQuotes',
    category: 'Editor',
    label: 'Auto-close quotes " " and \' \'',
    type: 'boolean',
    default: false,
    description: 'Automatically insert closing quote when typing a single or double quote.'
  },
  { key: 'editor.autoIndent', category: 'Editor', label: 'Automatic indentation', type: 'boolean', default: true },
  { key: 'editor.multiCursorModifier', category: 'Editor', label: 'Multi-cursor modifier', type: 'enum', options: ['alt', 'ctrlCmd'], default: 'alt' },
  { key: 'editor.cursorBlinking', category: 'Editor', label: 'Cursor blinking', type: 'enum', options: ['blink', 'smooth', 'phase', 'expand', 'solid'], default: 'smooth' },
  { key: 'editor.smoothCaret', category: 'Editor', label: 'Smooth caret animation', type: 'boolean', default: true },

  // ---------------------------------------------------------- Visual Editor
  { key: 'visual.enabled', category: 'Visual Editor', label: 'Enable Visual Mode', type: 'boolean', default: true },
  { key: 'visual.fontSize', category: 'Visual Editor', label: 'Font size', type: 'number', default: 16, min: 10, max: 32, step: 1 },
  { key: 'visual.fontFamily', category: 'Visual Editor', label: 'Serif font family', type: 'string', default: "'Latin Modern Roman', 'Computer Modern', Georgia, 'Times New Roman', serif" },
  { key: 'visual.lineWidth', category: 'Visual Editor', label: 'Readable line width', type: 'number', default: 760, min: 400, max: 1400, step: 20, description: 'Maximum width of the text column in Visual Mode.' },
  { key: 'visual.paragraphSpacing', category: 'Visual Editor', label: 'Paragraph spacing', type: 'number', default: 0.85, min: 0, max: 3, step: 0.05 },
  { key: 'visual.showRawLatexIslands', category: 'Visual Editor', label: 'Show unsupported LaTeX as editable source', type: 'boolean', default: true, description: 'Render what Eukolia understands; keep what it does not visibly editable.' },
  { key: 'visual.typesetDelayMs', category: 'Visual Editor', label: 'Mathematics typesetting delay (ms)', type: 'number', default: 120, min: 0, max: 2000, step: 10 },
  { key: 'visual.showMathToolbar', category: 'Visual Editor', label: 'Show mathematics toolbar on selection', type: 'boolean', default: true },
  {
    key: 'visual.revealCodeOnVerticalJump',
    category: 'Visual Editor',
    label: 'Reveal code on jumping up and down',
    type: 'boolean',
    default: true,
    description: 'Reveal underlying LaTeX code when navigating vertically into mathematics with up and down arrows. When disabled, the caret jumps past the rendered equation without expanding it.',
    keywords: ['math', 'vertical', 'jump', 'reveal', 'arrow', 'up', 'down']
  },
  {
    key: 'visual.displayAllEnvironmentBrackets',
    category: 'Visual Editor',
    label: 'Display all environment brackets',
    type: 'boolean',
    default: false,
    description: 'Display connecting brackets for all LaTeX environments in Visual Mode. When enabled, nested environments display nested brackets.',
    keywords: ['environment', 'bracket', 'nested', 'visual']
  },

  // ------------------------------------------------------------------ LaTeX
  { key: 'latex.completion.enabled', category: 'LaTeX', label: 'Enable completion', type: 'boolean', default: true, vscodeKey: 'latex-workshop.intellisense.completion' },
  { key: 'latex.completion.commands', category: 'LaTeX', label: 'Complete LaTeX commands', type: 'boolean', default: true },
  { key: 'latex.completion.environments', category: 'LaTeX', label: 'Complete environments', type: 'boolean', default: true },
  { key: 'latex.completion.packages', category: 'LaTeX', label: 'Complete package and class names', type: 'boolean', default: true },
  { key: 'latex.completion.citations', category: 'LaTeX', label: 'Complete citations', type: 'boolean', default: true, vscodeKey: 'latex-workshop.intellisense.citation.label' },
  { key: 'latex.completion.references', category: 'LaTeX', label: 'Complete references and labels', type: 'boolean', default: true },
  { key: 'latex.completion.files', category: 'LaTeX', label: 'Complete file paths', type: 'boolean', default: true },
  { key: 'latex.completion.unicodeMath', category: 'LaTeX', label: 'Complete Unicode mathematics symbols', type: 'boolean', default: true },
  { key: 'latex.hover.enabled', category: 'LaTeX', label: 'Show hover information', type: 'boolean', default: true },
  { key: 'latex.diagnostics.fromCompiler', category: 'LaTeX', label: 'Show compiler diagnostics', type: 'boolean', default: true },
  { key: 'latex.diagnostics.linter', category: 'LaTeX', label: 'Run the LaTeX linter while typing', type: 'boolean', default: true },
  { key: 'latex.diagnostics.delayMs', category: 'LaTeX', label: 'Linter delay (ms)', type: 'number', default: 400, min: 0, max: 5000, step: 50 },
  { key: 'latex.rootDocument', category: 'LaTeX', label: 'Root document', type: 'string', default: '', description: 'Leave empty for automatic detection (including % !TeX root magic comments).', projectScoped: true },

  // ------------------------------------------------------------ Compilation
  //
  // Every one of these is `projectScoped`: a build is the one thing that belongs
  // to the document rather than to the person reading it (see
  // `PROJECT_SCOPED_SETTINGS`).
  { key: 'compilation.engine', category: 'Compilation', label: 'Default engine', type: 'enum', options: ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'], default: 'latexmk', vscodeKey: 'latex-workshop.latex.recipe.default', projectScoped: true },
  { key: 'compilation.recipe', category: 'Compilation', label: 'Build recipe', type: 'string', default: 'latexmk', description: 'Name of the build recipe to use, or "default" for the engine above.', projectScoped: true },
  { key: 'compilation.extraArgs', category: 'Compilation', label: 'Extra compiler arguments', type: 'array', default: [], vscodeKey: 'latex-workshop.latex.args', projectScoped: true },
  { key: 'compilation.synctex', category: 'Compilation', label: 'Generate SyncTeX data', type: 'boolean', default: true, vscodeKey: 'latex-workshop.latex.autoBuild.run', projectScoped: true },
  { key: 'compilation.autoBuild', category: 'Compilation', label: 'Build automatically on save', type: 'enum', options: ['never', 'onSave', 'onFileChange'], default: 'never', vscodeKey: 'latex-workshop.latex.autoBuild.run', projectScoped: true },
  { key: 'compilation.autoBuildDelayMs', category: 'Compilation', label: 'Automatic build delay (ms)', type: 'number', default: 800, min: 0, max: 20000, step: 100 },
  { key: 'compilation.cleanAfterFailedBuild', category: 'Compilation', label: 'Clean auxiliary files after a failed build', type: 'boolean', default: false },
  {
    key: 'compilation.cleanExtensions',
    category: 'Compilation',
    label: 'Auxiliary extensions to clean',
    type: 'array',
    // The same list the main process falls back to when nothing is sent
    // (`shared/cleanExtensions.ts`): two lists for one command is how `.xdv`,
    // `.dvi` and the glossary family came to survive a clean.
    default: [...CLEAN_EXTENSIONS],
    projectScoped: true
  },
  { key: 'compilation.outputDirectory', category: 'Compilation', label: 'Output directory', type: 'string', default: '', description: 'Leave empty to build next to the source file.', projectScoped: true },
  {
    key: 'compilation.latexmk.minimumRule',
    category: 'Compilation',
    label: 'latexmk: force every rule (-g)',
    type: 'boolean',
    default: false,
    description:
      'Run every latexmk rule on every build, whatever the timestamps say. Off by default: latexmk\'s own up-to-date check is what makes an unchanged document build in a fraction of a second. The Rebuild command forces one build without changing this.',
    projectScoped: true
  },
  { key: 'compilation.maxLogLines', category: 'Compilation', label: 'Compiler output lines to keep', type: 'number', default: 20000, min: 1000, max: 500000, step: 1000 },

  // -------------------------------------------------------------------- PDF
  // ------------------------------------------------- PDF (ported from light-pdf)
  //
  // These are light-pdf's own preferences, under its own names, so the viewer
  // behaves as light-pdf's settings say it should rather than as a lookalike.
  // The defaults match `Settings.h` where light-pdf has one.
  {
    key: 'pdf.lightPdfTheme',
    category: 'PDF',
    label: 'Viewer theme',
    type: 'enum',
    // `auto` is light-pdf's "follow the application theme"; the rest are the
    // named themes from its `Theme.cpp` table, in its own order.
    options: ['auto', ...LIGHTPDF_THEME_NAMES],
    default: 'auto',
    description:
      'The colour scheme of the PDF viewer chrome and page background. "auto" follows the application theme.'
  },
  {
    key: 'pdf.selectionColor',
    category: 'PDF',
    label: 'Selection colour',
    type: 'color',
    default: '#ffff00',
    description: 'Used for text selections and for the current find result.'
  },
  {
    key: 'pdf.selectionAlpha',
    category: 'PDF',
    label: 'Selection opacity',
    type: 'number',
    default: 95,
    min: 0,
    max: 255,
    step: 5,
    description: 'Selections are drawn at opacity 95 unless the colour carries its own alpha.'
  },
  { key: 'pdf.defaultZoom', category: 'PDF', label: 'Default zoom', type: 'enum', options: ['auto', 'page-width', 'page-fit', 'page-height', 'actual', 'fit-content'], default: 'page-width' },
  {
    key: 'pdf.scrollMode',
    category: 'PDF',
    label: 'Display mode',
    type: 'enum',
    // light-pdf's `DisplayMode` names, in its own order.
    options: ['automatic', 'single-page', 'facing', 'book', 'continuous', 'continuous-facing', 'continuous-book'],
    default: 'continuous',
    description: 'PDF display modes. "automatic" resolves to continuous for a single-page layout.'
  },
  // ------------------------------------- PDF (light-pdf viewer preferences)
  //
  // light-pdf `Toolbar` (3.7) and the `ShowToolbar` boolean it replaced
  // (`gen-settings.ts:706-720`; normalised in `AppSettings.cpp:400-407`,
  // `ToolbarModeFromPrefs` in `LightPDF.cpp:1154-1161`). "overlay" is light-pdf's
  // floating toolbar: sized to its natural width, centred, and revealed when the
  // pointer comes near it (`Toolbar.cpp:485-650`).
  {
    key: 'pdf.toolbar',
    category: 'PDF',
    label: 'Toolbar',
    type: 'enum',
    options: ['show', 'hide', 'overlay'],
    default: 'show',
    description:
      'Toolbar modes: "show" is the pinned bar, "hide" removes it, "overlay" floats it over the page and reveals it when the pointer is near. Toggle Toolbar (F8) switches between "show" and "hide".'
  },
  {
    key: 'pdf.toolbarPosition',
    category: 'PDF',
    label: 'Toolbar position',
    type: 'enum',
    options: ['top', 'bottom'],
    default: 'top',
    // gen-settings.ts:715-720; `ToolbarPositionFromPrefs`, `LightPDF.cpp:1184-1190`.
    description: 'Where the pinned or floating toolbar sits.'
  },
  {
    key: 'pdf.toolbarSize',
    category: 'PDF',
    label: 'Toolbar icon size',
    type: 'number',
    default: 18,
    min: 8,
    max: 64,
    step: 1,
    // gen-settings.ts:799; `Toolbar.cpp:1281-1283` — the value is the icon size,
    // and `AppSettings.cpp:390-393` clamps it to 8…64 with 0 meaning "unset".
    description: 'The icon size in pixels; the bar is that icon box plus its padding.'
  },
  {
    key: 'pdf.showLinks',
    category: 'PDF',
    label: 'Show links',
    type: 'boolean',
    default: false,
    // gen-settings.ts:735; drawn by `Canvas.cpp:1829-1857` (`DebugShowLinks`):
    // a 1px blue rectangle, inflated by 2px, around every link element.
    description: 'Draws a 1px blue rectangle around every link in the document.'
  },
  {
    key: 'pdf.showToc',
    category: 'PDF',
    label: 'Show bookmarks sidebar',
    type: 'boolean',
    default: true,
    // gen-settings.ts:729-734: "we show table of contents (Bookmarks) sidebar if
    // it's present in the document", which is why the panel only appears for a
    // document that actually has an outline (`CmdToggleBookmarks`, F12).
    description: 'Shows the document\'s bookmarks (table of contents) beside the page when the PDF has one. F12 toggles it.'
  },
  {
    key: 'pdf.documentColorsFollowTheme',
    category: 'PDF',
    label: 'Document colours follow the theme',
    type: 'enum',
    options: ['off', 'smart', 'legacy'],
    default: 'off',
    // gen-settings.ts:784-791; `DocumentColorsFollowThemeFromString` in
    // `PdfDarkModeColor.cpp:34-55`; the page colours come from
    // `Theme.cpp:420-461` (`ThemePageRenderColors`).
    description:
      'Whether the pages and the canvas follow the viewer theme: "off" keeps the document\'s own colours, "smart" recolours text and background but not images, "legacy" recolours the whole page.'
  },
  {
    key: 'pdf.windowBackgroundColor',
    category: 'PDF',
    label: 'Page area background',
    type: 'string',
    default: '',
    // gen-settings.ts:284; applied in `Canvas.cpp:1996-2001`, which lets it
    // override the canvas colour for PDF documents only.
    description: 'Background colour behind the pages, e.g. #202020. Empty keeps the theme\'s own colour.'
  },
  {
    key: 'pdf.mainWindowBackground',
    category: 'PDF',
    label: 'Light theme window background',
    type: 'string',
    default: '#80fff200',
    // gen-settings.ts:652 with the default from `Settings.h:1180`;
    // `ThemeMainWindowBackgroundColor`, `Theme.cpp:469-479`, applies it to the
    // light theme only, and `IsDefaultMainWinColor` (`Theme.cpp:305`) treats the
    // compiled default as "not set".
    description:
      'Overrides the light theme\'s window background — the canvas the pages sit on. `#80fff200` (its default) means "use the theme\'s own colour".'
  },
  // ------------------------------------ PDF (light-pdf scrolling and scrolling UI)
  //
  // The scroll behaviour preferences `Canvas.cpp` owns: the wheel policy
  // (`OnMouseWheel`), the smooth-scroll integrator and the scrollbar modes.
  {
    key: 'pdf.scrollSensitivity',
    category: 'PDF',
    label: 'Scroll wheel sensitivity',
    type: 'number',
    default: 3,
    min: 0.1,
    max: 10,
    step: 0.1,
    // gen-settings.ts:747 (default 2.0); `Canvas.cpp:2586-2588` multiplies the
    // wheel delta by it, and `Canvas.cpp:2738` uses it again as the impulse
    // multiplier of the smooth-scroll integrator, on a `targetDistance` that its
    // own `:2587` had already scaled. A gliding notch therefore travels `24 * S²`
    // — 216 px at 3, against the 96 px light-pdf's 2 moves — while the plain line
    // path (`pdf.smoothScroll` off) travels `48 * S`, 144 px. The default here is
    // 3 rather than light-pdf's 2.0, and the departure lives in this descriptor,
    // as `pdf.scrollbar`'s does, so a stored value is still honoured.
    // `lightPdfScrollSensitivity` keeps light-pdf's own 2.0 for a value that is
    // missing or nonsense.
    description:
      'Multiplier for how far one wheel notch scrolls. While smooth scrolling is on it is applied twice, so a notch travels further than the number alone suggests.'
  },
  {
    key: 'pdf.scrollbar',
    category: 'PDF',
    label: 'Scrollbars',
    type: 'enum',
    options: ['windows', 'smart', 'overlay', 'hidden'],
    // light-pdf's own default is `windows`, the platform bar
    // (`gen-settings.ts:738-743`), and an overlay default is a deliberate
    // departure from it. The platform bar is drawn *inside* the pane and reserves
    // its width, so a pane whose content is wider than the viewport — a page at
    // `fit width`, which is the reading mode most documents are read in — never
    // reaches the window's right edge however the page is fitted: a scrollbar's
    // width of background sits beside it, and the fitted page is laid out for the
    // narrower client box. That strip is what "the viewer does not reach the edge"
    // looks like. `smart` draws light-pdf's own overlay bar over the page instead
    // (`LightPDF.cpp:1140-1150`), which reserves nothing, and light-pdf's `windows`
    // and `hidden` remain one setting away.
    default: 'smart',
    // gen-settings.ts:738-743; `LightPDF.cpp:1126-1150` (`gScrollbarModeNames`,
    // `ScrollbarModeFromPrefs`, `ScrollbarsUseOverlay`, `ScrollbarsOverlayMode`).
    // `CmdChangeScrollbar` (232) is the "Change Scrollbar…" dialog that writes it.
    description:
      'Scrollbar modes: "windows" is the platform scrollbar, which reserves a strip inside the pane, "smart" an overlay bar that floats over the page and hides itself, "overlay" an overlay bar that stays, "hidden" none at all.'
  },
  {
    key: 'pdf.scrollbarInSinglePage',
    category: 'PDF',
    label: 'Page slider in single-page view',
    type: 'boolean',
    default: false,
    // gen-settings.ts:744; `Canvas.cpp:639-693` — in single-page mode the
    // scrollbar becomes a page slider and `Canvas.cpp:3199-3202` keeps it shown
    // even when the page fits.
    description: 'Shows the scrollbar in single-page view and makes its position the page number, so the bar turns pages.'
  },
  {
    key: 'pdf.smoothScroll',
    category: 'PDF',
    label: 'Momentum scrolling',
    type: 'boolean',
    default: true,
    // gen-settings.ts:740-745 (default true); `Canvas.cpp:2730-2751` — the wheel
    // feeds an impulse into the velocity integrator (`:2259-2313`) instead of
    // scrolling by a fixed distance, so the page glides to a stop.
    //
    // This is light-pdf's own preference, and it is deliberately separate from
    // Eukolia's `scrolling.smooth` (which is the browser-level animation the rest
    // of the app uses): light-pdf's momentum is a physics integrator with its own
    // friction, and gating it on a generic smooth-scrolling toggle meant a user
    // could turn momentum off without meaning to, or leave it on and never reach
    // it.
    description:
      'Velocity-based wheel scrolling: each notch feeds an impulse into an integrator that decays, so the page glides to a stop. Off scrolls by a fixed distance per notch instead.'
  },
  {
    key: 'pdf.smoothScrollFriction',
    category: 'PDF',
    label: 'Smooth scroll friction',
    type: 'number',
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.01,
    // gen-settings.ts:746 — "how fast the smooth scrolling stops (0 to 1),
    // higher is faster stop"; the decay is `exp(-friction*50*dt)`
    // (`Canvas.cpp:2285-2287`), floored at a rate of 1.
    description: 'How quickly momentum scrolling stops (0 to 1; higher stops sooner). Default is 0.2.'
  },
  {
    key: 'pdf.fastScrollOverScrollbar',
    category: 'PDF',
    label: 'Fast scroll over the scrollbar',
    type: 'boolean',
    default: false,
    // gen-settings.ts:764-768; `Canvas.cpp:2718-2728` — a wheel notch scrolls
    // half a page when the pointer is over the scrollbar strip.
    description: 'A wheel notch scrolls half a page instead of a few lines while the pointer is over the scrollbar.'
  },
  {
    key: 'pdf.zoomLevels',
    category: 'PDF',
    label: 'Zoom ladder',
    type: 'array',
    default: [],
    // gen-settings.ts:834-840 (`compactArray`): the values replace
    // `DisplayModel.cpp:1739-1743`'s `defaultZoomLevels`, and `AppSettings.cpp:349-355`
    // sorts them and drops anything outside `[kZoomMin, kZoomMax]` = 8.33 … 6400.
    description:
      'Zoom percentages to step through, e.g. 50, 100, 200. Empty uses the built-in ladder (8.33 … 6400).',
  },
  {
    key: 'pdf.zoomIncrement',
    category: 'PDF',
    label: 'Zoom step (%)',
    type: 'number',
    default: 0,
    min: 0,
    max: 200,
    step: 1,
    // gen-settings.ts:842-848 — "zoom step size in percents relative to the
    // current zoom level; if zero or negative, the values from ZoomLevels are
    // used instead" (`DisplayModel.cpp:1719-1734`).
    description: 'Relative zoom step in percent, e.g. 10 for +10 % per press. 0 uses the zoom ladder instead.'
  },
  {
    key: 'pdf.windowMargin',
    category: 'PDF',
    label: 'Window margin',
    type: 'string',
    default: '2 4 2 4',
    // gen-settings.ts:232-237 (`windowMarginFixedPageUI`, Top/Right/Bottom/Left,
    // defaults 2/4/2/4) and the captured settings file's own `WindowMargin = 2 4 2 4`.
    // `DocumentLayout.cpp` insets the canvas by them.
    description: 'Margin between the window edge and the document: top right bottom left, all in points.'
  },
  {
    key: 'pdf.pageSpacing',
    category: 'PDF',
    label: 'Page spacing',
    type: 'string',
    default: '4 4',
    // gen-settings.ts:245-250 (`gSizeFields`, defaults 4/4) and the captured
    // settings file's own `PageSpacing = 4 4`. `DocumentLayout.cpp` puts `dx`
    // between the columns of a row and `dy` between rows.
    description: 'Gap between pages: horizontal vertical, both in points.'
  },
  {
    key: 'pdf.selectionToolbar',
    category: 'PDF',
    label: 'Selection toolbar',
    type: 'boolean',
    default: true,
    // gen-settings.ts:445-450 (the `Annotations` struct, default true); the
    // card itself is `SelectionToolbar.cpp:61-84`'s `gCandidateButtons` list.
    description:
      'Pops a small floating card next to a text selection. Only the buttons whose command Eukolia implements are shown — today that is Copy.'
  },
  {
    key: 'pdf.forwardSearchHighlightColor',
    category: 'PDF',
    label: 'SyncTeX highlight colour',
    type: 'color',
    default: '#6581ff',
    // gen-settings.ts:223; painted at `kSelectionDefaultAlpha` by
    // `SearchAndDDE.cpp:1485-1487` (`PaintForwardSearchMark`).
    description: 'Colour of the forward-search (SyncTeX) highlight on the page.'
  },
  {
    key: 'pdf.forwardSearchHighlightWidth',
    category: 'PDF',
    label: 'SyncTeX marker width',
    type: 'number',
    default: 15,
    min: 0,
    max: 200,
    step: 1,
    // gen-settings.ts:222 — "width of the highlight rectangle (if
    // HighlightOffset is > 0)"; `SearchAndDDE.cpp:1478` falls back to 15 when it
    // is not positive.
    description: 'Width of the left-margin marker, in points. Only used when the SyncTeX margin offset is above 0.'
  },
  {
    key: 'pdf.forwardSearchHighlightOffset',
    category: 'PDF',
    label: 'SyncTeX margin offset',
    type: 'number',
    default: 0,
    min: 0,
    max: 200,
    step: 1,
    // gen-settings.ts:214-221 — "when set to a positive value, the forward
    // search highlight style will be changed to a rectangle at the left of the
    // page (with the indicated amount of margin from the page margin)";
    // `SearchAndDDE.cpp:1475-1481`.
    description: 'Draws the SyncTeX highlight as a marker in the page\'s left margin, that many points in. 0 highlights the synced text itself.'
  },
  {
    key: 'pdf.forwardSearchHighlightPermanent',
    category: 'PDF',
    label: 'Keep the SyncTeX highlight',
    type: 'boolean',
    default: false,
    // gen-settings.ts:224-229 — "if true, highlight remains visible until the
    // next mouse click (instead of fading away immediately)";
    // `SearchAndDDE.cpp:1625-1627` arms `HIDE_FWDSRCHMARK_TIMER_ID`.
    description: 'Keeps the SyncTeX highlight on the page until the next click. Off fades it out shortly after it appears.'
  },
  { key: 'pdf.renderAheadPages', category: 'PDF', label: 'Pages to prefetch', type: 'number', default: 2, min: 0, max: 10, step: 1 },
  { key: 'pdf.maxCachedPages', category: 'PDF', label: 'Maximum cached rendered pages', type: 'number', default: 24, min: 2, max: 512, step: 2 },
  {
    key: 'pdf.focusFloatWidth',
    category: 'PDF',
    label: 'Floating viewer width in Focus Mode',
    type: 'number',
    default: 720,
    min: 320,
    max: 1600,
    step: 20,
    // Focus Mode has no room for a docked pane, so the viewer arrives as an
    // overlay whose width is its own — the split's remembered ratio describes a
    // two-pane window and would say nothing about how much of a one-pane window
    // the overlay should cover. Drag the overlay's left edge to change it; this
    // is the value that drag writes.
    description:
      'Width in pixels of the floating PDF viewer that Alt reveals in Focus Mode. Its own value, separate from the split layout\'s pane sizes — drag the overlay\'s left edge to change it.'
  },
  // There is deliberately no `pdf.devicePixelRatioCap`. It was the render scale
  // ceiling — device pixels per PDF point — and its default of 4 meant the engine
  // was asked for fewer pixels than the page occupied on screen from 400 % zoom
  // (320 % on a 125 %-scale display), which the canvas then stretched: a page that
  // is sharp until you zoom in and softens after. light-pdf has no such limit
  // because it rasterises only the tiles on screen, while Eukolia rasterises whole
  // pages, so the setting was a fidelity limit rather than a preference. The
  // viewer now asks for the scale the display actually needs; the one remaining
  // bound is a whole-page allocation guard far outside normal use
  // (`LIGHTPDF_MAX_RENDER_SCALE`), and it is reported in the pane instead of
  // silently softening the page. Memory is bounded by `pdf.maxCachedPages` and the
  // prefetch window, which is what they are for.
  { key: 'pdf.invertColors', category: 'PDF', label: 'Invert PDF colours', type: 'enum', options: ['never', 'whenThemeDark', 'always'], default: 'never' },
  { key: 'pdf.synctexForwardSearch', category: 'PDF', label: 'SyncTeX forward search on Ctrl+Click', type: 'boolean', default: true },
  { key: 'pdf.synctexInverseSearch', category: 'PDF', label: 'SyncTeX inverse search on Ctrl+Click', type: 'boolean', default: true },
  { key: 'pdf.highlightSyncPosition', category: 'PDF', label: 'Highlight the synced position', type: 'boolean', default: true },
  { key: 'pdf.jumpToPdfOnBuild', category: 'PDF', label: 'Reveal the PDF after a successful build', type: 'boolean', default: false },

  // --------------------------------------------------------------- Snippets
  { key: 'snippets.enabled', category: 'Snippets', label: 'Enable the snippet engine', type: 'boolean', default: true },
  { key: 'snippets.autoExpand', category: 'Snippets', label: 'Expand automatic snippets while typing', type: 'boolean', default: true, description: 'Entries set to expand automatically fire as soon as their trigger matches.' },
  {
    key: 'snippets.expandOnEnter',
    category: 'Snippets',
    label: 'Expand snippets on Enter',
    type: 'boolean',
    default: true,
    description: 'Allow pressing Enter to expand snippets from the completion list.',
    keywords: ['snippet', 'snippets', 'expansion', 'key', 'enter', 'tab', 'expand']
  },
  {
    key: 'snippets.expandOnTab',
    category: 'Snippets',
    label: 'Expand snippets on Tab',
    type: 'boolean',
    default: false,
    description: 'Allow pressing Tab to expand snippets from the completion list or when the trigger matches.',
    keywords: ['snippet', 'snippets', 'expansion', 'key', 'enter', 'tab', 'expand']
  },
  { key: 'snippets.allowJavaScript', category: 'Snippets', label: 'Allow JavaScript in snippets', type: 'boolean', default: true, description: 'Snippets can compute their expansion with backtick JavaScript. Disable to run in a restricted mode.' },
  { key: 'snippets.multiLineContext', category: 'Snippets', label: 'Lines of context for multi-line triggers', type: 'number', default: 20, min: 1, max: 200, vscodeKey: 'hsnips.multiLineContext' },
  { key: 'snippets.snippetDirectories', category: 'Snippets', label: 'Snippet directories', type: 'array', default: ['snips'], projectScoped: true },
  {
    key: 'snippets.userSnippetsDirectory',
    category: 'Snippets',
    label: 'User snippets folder',
    type: 'string',
    default: '',
    description:
      'Folder where your personal snippets (snippets.json) and global scripts (globals.js) are stored. Leave empty to use the .eukolia folder of your project library, which is where your settings live too; before a library is set up this falls back to User/snippets in application data.'
  },
  { key: 'snippets.tabStopKey', category: 'Snippets', label: 'Jump to next placeholder', type: 'string', default: 'Tab' },

  // ------------------------------------------------------------- Formatting
  { key: 'formatting.alignAmpersands', category: 'Formatting', label: 'Align ampersands', type: 'boolean', default: true, description: 'Vertically align & inside align, aligned, matrix, cases, tabular and similar environments.' },
  { key: 'formatting.alignEnvironments', category: 'Formatting', label: 'Environments to align', type: 'array', default: ['align', 'align*', 'aligned', 'matrix', 'pmatrix', 'pmatrix*', 'bmatrix', 'bmatrix*', 'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*', 'Bmatrix', 'Bmatrix*', 'array', 'array*', 'tabular', 'tikzcd', 'case', 'alignedat'], vscodeKey: 'texAligner.environments' },
  { key: 'formatting.ampersandPadding', category: 'Formatting', label: 'Spaces around &', type: 'number', default: 1, min: 1, max: 8, step: 1 },
  { key: 'formatting.alignOnSave', category: 'Formatting', label: 'Align on save', type: 'boolean', default: false },
  { key: 'formatting.alignWhileTyping', category: 'Formatting', label: 'Align while typing', type: 'boolean', default: false, description: 'Re-align the enclosing environment shortly after you stop typing.' },
  { key: 'formatting.alignWhileTypingDelayMs', category: 'Formatting', label: 'Align while typing delay (ms)', type: 'number', default: 900, min: 100, max: 10000, step: 100 },
  { key: 'formatting.trimTrailingWhitespaceOnSave', category: 'Formatting', label: 'Trim trailing whitespace on save', type: 'boolean', default: false },

  // ------------------------------------------------------------------ Files
  {
    key: 'files.autoSave',
    category: 'Files',
    label: 'Auto save',
    type: 'enum',
    // VS Code's `files.autoSave`, with its four values in its own order. The
    // modes differ only in *when* they write, so the per-option sentences below
    // carry the whole difference: `onFocusChange` saves when focus leaves the
    // editor (including when the window loses focus), `onWindowChange` only when
    // the window does. `afterDelay` is the one mode with a timer, and the one
    // `files.autoSaveDelayMs` applies to.
    options: AUTO_SAVE_MODES,
    optionDescriptions: AUTO_SAVE_MODE_DESCRIPTIONS,
    default: DEFAULT_AUTO_SAVE_MODE,
    description:
      'Controls auto save of editors that have unsaved changes. A buffer with no file yet is never saved automatically — there is nowhere to write it — so it stays dirty in the tab and is covered by crash recovery until you save it yourself.',
    keywords: ['save', 'auto save', 'autosave', 'auto-save', 'delay', 'focus', 'blur', 'window']
  },
  {
    key: 'files.autoSaveDelayMs',
    category: 'Files',
    label: 'Auto save delay (ms)',
    type: 'number',
    default: 1500,
    min: 100,
    max: 60000,
    step: 100,
    // VS Code's `files.autoSaveDelay`: "Only applies when `files.autoSave` is set
    // to `afterDelay`." The floor is 100 ms rather than VS Code's 0 — a timer that
    // fires while the key is still going down writes on every keystroke, which is
    // what `afterDelay` exists to avoid.
    description: 'How long a buffer must sit unchanged before auto save writes it. Only applies when auto save is set to "afterDelay".'
  },
  { key: 'files.safeWrite', category: 'Files', label: 'Safe writes', type: 'boolean', default: true, description: 'Write to a temporary file and rename, so a crash cannot truncate your document.' },
  { key: 'files.detectExternalChanges', category: 'Files', label: 'Detect external file changes', type: 'boolean', default: true },
  { key: 'files.autoGuessEncoding', category: 'Files', label: 'Detect file encoding', type: 'boolean', default: true },
  { key: 'files.encoding', category: 'Files', label: 'Default encoding', type: 'enum', options: ['utf8', 'utf16le', 'latin1'], default: 'utf8' },
  {
    key: 'files.exclude',
    category: 'Files',
    label: 'Explorer exclude patterns',
    type: 'array',
    // `.eukolia` holds this application's own workspace settings file. It is
    // listed as a removable default rather than a hard exclusion, so the tree is
    // not cluttered by a directory the project never asked for while a user who
    // wants to hand-edit it can still browse to it.
    default: ['.git', 'node_modules', '__pycache__', '.DS_Store', 'out', 'dist', '.eukolia']
  },
  {
    key: 'files.watcherExclude',
    category: 'Files',
    label: 'Watcher exclude patterns',
    type: 'array',
    /*
     * VS Code's `files.watcherExclude`, with VS Code's intent: the directories a
     * file watcher would otherwise descend into and report on, which is dependency
     * and VCS *internals* rather than everything the Explorer hides. The two
     * settings are separate there for a reason — a build output directory is worth
     * hiding from the tree but is often exactly what a watcher is being used to
     * notice — so this list is narrower than `files.exclude` on purpose.
     *
     * Names, not globs: the application's settings speak in directory names
     * everywhere (`files.exclude`, `files.explorerInclude`), and a second pattern
     * language for one key would be a vocabulary of two. The main process also
     * skips its own always-excluded set (`.git`, `node_modules`, `__pycache__`,
     * `.vs`, `.idea`, …) whatever this says, which is what VS Code's default globs
     * amount to.
     */
    default: ['node_modules', '.git', '.hg', '.svn', '__pycache__'],
    description:
      'Directories the file watcher never descends into. Changes inside them are not noticed, so the Explorer does not update for them until a refresh. Names, not globs.'
  },
  {
    key: 'search.exclude',
    category: 'Files',
    label: 'Search exclude patterns',
    type: 'array',
    /*
     * VS Code's `search.exclude`: "Configure glob patterns for excluding files and
     * folders in fulltext searches and file search in quick open. ... Inherits all
     * glob patterns from the `files.exclude` setting."
     *
     * The inheritance is why the search request sends the *union* of the two lists
     * rather than this one alone, and why the default here is only what search adds
     * on top of the Explorer's excludes: dependency directories and VS Code's own
     * search index, not everything the tree hides.
     *
     * Filed under Files rather than in a category of its own because it is one
     * setting, and it belongs beside the exclude it inherits from.
     */
    default: ['node_modules', 'bower_components'],
    description:
      'Directories project search skips, in addition to the Explorer excludes. Names, not globs. VS Code default: **/node_modules, **/bower_components, **/*.code-search.'
  },
  {
    key: 'files.explorerInclude',
    category: 'Files',
    label: 'Explorer file types',
    type: 'array',
    default: [
      // Documents — what a LaTeX project is read and written as.
      'tex', 'ltx', 'pdf', 'md',
      // LaTeX source and support files. These are ordinary project files the
      // editor opens, so they belong in the tree alongside the documents.
      'bib', 'cls', 'sty', 'def', 'tikz', 'dtx', 'ins', 'txt',
      // Images a document `\includegraphics`.
      'png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'webp', 'eps', 'tif', 'tiff',
      // Source files, for projects that mix prose with code.
      'py', 'java', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'js', 'mjs', 'cjs',
      'ts', 'tsx', 'jsx', 'sh', 'bash', 'ps1', 'r', 'jl', 'm', 'go', 'rs',
      'rb', 'pl', 'lua', 'sql', 'html', 'css', 'xml', 'yml', 'yaml', 'toml',
      'json', 'csv', 'ini', 'cfg'
    ],
    description:
      'Only files with these extensions appear in the Explorer. Write them without the dot (tex, not .tex). Folders are unaffected and stay visible even when this hides everything inside them; build artefacts such as aux, log and out are excluded by default, so add them if you want to browse them.'
  },
  { key: 'files.trimFinalNewline', category: 'Files', label: 'Ensure a final newline on save', type: 'boolean', default: false },

  // ------------------------------------------------------------- Appearance
  { key: 'appearance.uiDensity', category: 'Appearance', label: 'UI density', type: 'enum', options: ['comfortable', 'compact'], default: 'compact' },
  { key: 'appearance.accentColor', category: 'Appearance', label: 'Accent colour', type: 'color', default: '#059669' },
  // There is deliberately no `appearance.showToolbar` and no `appearance.showMenuBar`.
  //
  // The first existed and nothing read it, because there is no separate main toolbar to
  // hide: what it would have governed lives in the tab strip and the status bar, which
  // have their own toggles that are real (`view.toggleTabBar`, `view.toggleStatusBar`).
  // The second hid the File/Edit/View… menu strip inside the title bar — and the title
  // bar itself is gone: the menus are the sidebar's Menu view (`view.menu`) and the
  // command palette now, so there is nothing left for a "show the menu bar" switch to
  // switch. A setting that outlives its surface is the nonfunctional UI §72 rules out, so
  // it was removed with the surface rather than left behind reading nothing.
  //
  // The window's own chrome follows the same rule: the tab bar carries the drag region
  // and the caption buttons, so `view.toggleTabBar` hides the *tabs* rather than the bar,
  // and there is no setting that can leave the window unmovable, unclosable or unbuildable.
  { key: 'appearance.showStatusBar', category: 'Appearance', label: 'Show the status bar', type: 'boolean', default: true },
  { key: 'appearance.showActivityBar', category: 'Appearance', label: 'Show the activity bar', type: 'boolean', default: true },
  {
    key: 'appearance.collapseActivityBarWithSidebar',
    category: 'Appearance',
    label: 'Collapse the activity bar with the sidebar',
    type: 'boolean',
    // On by default: the strip holds the buttons for the sidebar's own views, so
    // collapsing the sidebar and leaving them behind puts the controls for six
    // panels on screen with none of those panels rendered.
    default: true,
    description:
      'On: toggling the sidebar hides the activity bar panel buttons together with the sidebar (Toggle Panel Bar is off). Off: only the sidebar container collapses and the activity bar panel buttons stay visible (Toggle Panel Bar is on). Toggling panel buttons never hides the Menu button.'
  },
  { key: 'appearance.sidebarWidth', category: 'Appearance', label: 'Sidebar width', type: 'number', default: 260, min: 140, max: 700, step: 10, requiresReload: false },
  { key: 'appearance.animations', category: 'Appearance', label: 'Interface animations', type: 'boolean', default: true },

  // -------------------------------------------------------------- Scrolling
  { key: 'scrolling.smooth', category: 'Scrolling', label: 'Smooth scrolling', type: 'boolean', default: true, description: 'Core requirement: one wheel handler for the whole shell — the editor, the file tree, panels, menus, the palette and the tab manager. The PDF viewer and the terminal keep their own engines.' },
  { key: 'scrolling.smoothDurationMs', category: 'Scrolling', label: 'Smooth scroll duration (ms)', type: 'number', default: 180, min: 0, max: 1000, step: 10 },
  { key: 'scrolling.mouseWheelZoom', category: 'Scrolling', label: 'Ctrl+wheel adjusts the PDF zoom', type: 'boolean', default: true },
  { key: 'scrolling.scrollPastEnd', category: 'Scrolling', label: 'Allow scrolling past the last line', type: 'boolean', default: true },
  { key: 'scrolling.stickyScroll', category: 'Scrolling', label: 'Sticky scroll (show enclosing environment)', type: 'boolean', default: true },
  { key: 'scrolling.preserveScrollOnRender', category: 'Scrolling', label: 'Keep the scroll position stable during rendering', type: 'boolean', default: true, description: 'Prevents jumps caused by mathematics typesetting, PDF page rendering or image loading.' },
  { key: 'scrolling.trackpadMomentum', category: 'Scrolling', label: 'Respect trackpad momentum', type: 'boolean', default: true },

  // --------------------------------------------------------------- Keyboard
  { key: 'keyboard.paletteKey', category: 'Keyboard', label: 'Command palette shortcut', type: 'string', default: 'Ctrl+Shift+P' },
  { key: 'keyboard.quickOpenKey', category: 'Keyboard', label: 'Quick open shortcut', type: 'string', default: 'Ctrl+P' },
  { key: 'keyboard.buildKey', category: 'Keyboard', label: 'Build shortcut', type: 'string', default: 'Ctrl+B' },
  { key: 'keyboard.viewPdfKey', category: 'Keyboard', label: 'Toggle PDF shortcut', type: 'string', default: 'Ctrl+Alt+V' },
  { key: 'keyboard.customBindings', category: 'Keyboard', label: 'Custom keybindings', type: 'array', default: [] },

  // ------------------------------------------- Keyboard: panel and view toggles
  //
  // One setting per toggle so each can be rebound from the Settings UI. Any
  // *other* command can be rebound by adding `"keybindings.<command id>"` to the
  // advanced-settings JSON — the file is not limited to the keys listed here.
  { key: 'keybindings.toggleTerminal', category: 'Keyboard', label: 'Toggle terminal', type: 'string', default: 'Ctrl+`' },
  { key: 'keybindings.toggleSidebar', category: 'Keyboard', label: 'Toggle sidebar', type: 'string', default: 'Ctrl+B' },
  { key: 'keybindings.togglePdfViewer', category: 'Keyboard', label: 'Toggle PDF viewer', type: 'string', default: 'Ctrl+Alt+V' },
  { key: 'keybindings.toggleTabBar', category: 'Keyboard', label: 'Toggle tab bar', type: 'string', default: 'Ctrl+Alt+T' },
  { key: 'keybindings.toggleBottomPanel', category: 'Keyboard', label: 'Toggle bottom panel', type: 'string', default: 'Ctrl+J' },
  { key: 'keybindings.toggleStatusBar', category: 'Keyboard', label: 'Toggle status bar', type: 'string', default: 'Ctrl+Alt+B' },
  { key: 'keybindings.toggleFocusMode', category: 'Keyboard', label: 'Toggle focus mode', type: 'string', default: 'Ctrl+Alt+1', description: 'Focus Mode is the editor alone; its View menu entry and the tab bar’s control enter it and leave it.' },
  { key: 'keybindings.tabSwitcher', category: 'Keyboard', label: 'Tab switcher (hold Ctrl, press Tab)', type: 'string', default: 'Ctrl+Tab' },
  { key: 'keybindings.commandPalette', category: 'Keyboard', label: 'Command palette', type: 'string', default: 'Ctrl+Shift+P' },
  { key: 'keybindings.quickOpen', category: 'Keyboard', label: 'Go to file', type: 'string', default: 'Ctrl+P' },
  { key: 'keybindings.build', category: 'Keyboard', label: 'Build project', type: 'string', default: 'Ctrl+B' },
  { key: 'keybindings.openSettings', category: 'Keyboard', label: 'Open settings', type: 'string', default: 'Ctrl+,' },
  { key: 'keybindings.openSnippets', category: 'Keyboard', label: 'Open the snippet library', type: 'string', default: 'Ctrl+Alt+L' },
  { key: 'keybindings.openShortcuts', category: 'Keyboard', label: 'Open keyboard shortcuts', type: 'string', default: 'Ctrl+K Ctrl+S' },
  { key: 'keybindings.advancedSettings', category: 'Keyboard', label: 'Open the advanced settings file', type: 'string', default: 'Ctrl+Alt+,' },
  { key: 'keybindings.saveFile', category: 'Keyboard', label: 'Save', type: 'string', default: 'Ctrl+S' },
  { key: 'keybindings.codeMode', category: 'Keyboard', label: 'Code mode', type: 'string', default: 'Ctrl+1' },
  { key: 'keybindings.visualMode', category: 'Keyboard', label: 'Visual mode', type: 'string', default: 'Ctrl+2' },

  // ---------------------------------------------------------------- Terminal
  { key: 'terminal.shell', category: 'Advanced', label: 'Terminal shell', type: 'string', default: '', description: 'Leave empty to use the platform default (PowerShell on Windows, $SHELL elsewhere).' },
  { key: 'terminal.cwdFollowsProject', category: 'Advanced', label: 'Start the terminal in the project folder', type: 'boolean', default: true },
  { key: 'terminal.scrollbackLines', category: 'Advanced', label: 'Terminal scrollback (lines)', type: 'number', default: 5000, min: 200, max: 200000, step: 100 },
  { key: 'terminal.fontSize', category: 'Advanced', label: 'Terminal font size', type: 'number', default: 13, min: 8, max: 28, step: 1, description: 'Point size of the terminal’s monospace font.', keywords: ['terminal', 'font', 'zoom'] },

  // --------------------------------------------------------------- Advanced
  {
    key: 'advanced.texPath',
    category: 'Advanced',
    label: 'TeX distribution bin directory',
    type: 'string',
    default: '',
    description:
      'Searched before PATH when a build looks for pdflatex, latexmk and the other TeX tools, and when the tools are detected. Set it when the distribution is installed but the application does not find it.',
    keywords: ['tex', 'latex', 'path', 'miktex', 'texlive', 'distribution', 'pdflatex', 'latexmk']
  },
  { key: 'advanced.logLevel', category: 'Advanced', label: 'Log level', type: 'enum', options: ['error', 'warn', 'info', 'debug', 'trace'], default: 'info' },
  { key: 'advanced.nativePdfEngine', category: 'Advanced', label: 'Use the native PDF engine', type: 'boolean', default: true, description: 'Disable to fall back to the JavaScript PDF path.' },
  { key: 'advanced.maxProjectFileSize', category: 'Advanced', label: 'Maximum indexed file size (KB)', type: 'number', default: 2048, min: 64, max: 65536, step: 64 },
  { key: 'advanced.telemetry', category: 'Advanced', label: 'Send anonymous usage data', type: 'boolean', default: false }
];

const schemaByKey = new Map(SETTINGS_SCHEMA.map((d) => [d.key, d]));

/*
 * The two spellings of "a project may set this" — the list above and the
 * `projectScoped` flag on each descriptor — are checked against each other once,
 * here, rather than trusted to stay in step. A key added to one and not the
 * other would otherwise be a setting that is project-scoped in the UI and not on
 * disk, or the reverse, and both are silent.
 */
for (const key of PROJECT_SCOPED_SETTINGS) {
  const descriptor = schemaByKey.get(key);
  if (!descriptor) {
    throw new Error(`PROJECT_SCOPED_SETTINGS names an undeclared setting: ${key}`);
  }
  if (descriptor.projectScoped !== true) {
    throw new Error(`PROJECT_SCOPED_SETTINGS and the schema disagree about ${key}`);
  }
}
for (const descriptor of SETTINGS_SCHEMA) {
  if (descriptor.projectScoped === true && !projectScopedKeys.has(descriptor.key)) {
    throw new Error(`the schema marks ${descriptor.key} project-scoped but the list does not name it`);
  }
}

/**
 * Settings key → command id, for every command whose shortcut has its own
 * setting and therefore appears in the Settings UI.
 *
 * Commands outside this list are still rebindable: the command registry also
 * accepts `"keybindings.<command id>"` from the advanced-settings JSON, which is
 * the escape hatch for anything the schema does not name.
 */
export const KEYBINDING_SETTINGS: Readonly<Record<string, string>> = {
  'keybindings.toggleTerminal': 'view.toggleTerminal',
  'keybindings.toggleSidebar': 'view.toggleSidebar',
  'keybindings.togglePdfViewer': 'pdf.toggleViewer',
  'keybindings.toggleTabBar': 'view.toggleTabBar',
  'keybindings.toggleBottomPanel': 'view.togglePanel',
  'keybindings.toggleStatusBar': 'view.toggleStatusBar',
  'keybindings.toggleFocusMode': 'view.focusMode',
  'keybindings.tabSwitcher': 'workbench.tabSwitcher',
  'keybindings.commandPalette': 'workbench.commandPalette',
  'keybindings.quickOpen': 'workbench.quickOpen',
  'keybindings.build': 'latex.build',
  'keybindings.openSettings': 'workbench.settings',
  'keybindings.openSnippets': 'workbench.snippets',
  'keybindings.openShortcuts': 'workbench.shortcuts',
  'keybindings.advancedSettings': 'workbench.advancedSettings',
  'keybindings.saveFile': 'file.save',
  'keybindings.codeMode': 'editor.codeMode',
  'keybindings.visualMode': 'editor.visualMode'
};

/** The settings key holding a command's shortcut, if it has a dedicated one. */
export function keybindingSettingFor(commandId: string): string | undefined {
  return Object.keys(KEYBINDING_SETTINGS).find(
    (key) => KEYBINDING_SETTINGS[key] === commandId
  );
}

export function getSettingDescriptor(key: string): SettingDescriptor | undefined {
  return schemaByKey.get(key);
}

/** Flat map of every default value. */
export function defaultSettingsRecord(): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const descriptor of SETTINGS_SCHEMA) {
    record[descriptor.key] = Array.isArray(descriptor.default) ? [...(descriptor.default as unknown[])] : descriptor.default;
  }
  return record;
}

export interface SettingsValidationError {
  key: string;
  message: string;
}

/**
 * Validates one value against the schema. Returns `undefined` when acceptable,
 * otherwise a human-readable reason.
 */
export function validateSettingValue(key: string, value: unknown): string | undefined {
  const descriptor = schemaByKey.get(key);
  if (!descriptor) return undefined;
  switch (descriptor.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (descriptor.min !== undefined && value < descriptor.min) return `must be at least ${descriptor.min}`;
      if (descriptor.max !== undefined && value > descriptor.max) return `must be at most ${descriptor.max}`;
      return undefined;
    }
    case 'string':
      return typeof value === 'string' ? undefined : 'must be text';
    case 'color':
      return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? undefined : 'must be a hex colour such as #059669';
    case 'enum':
      return descriptor.options && descriptor.options.includes(String(value))
        ? undefined
        : `must be one of: ${descriptor.options?.join(', ')}`;
    case 'array':
      return Array.isArray(value) ? undefined : 'must be a list';
    default:
      return undefined;
  }
}

export class SettingsManager extends EventEmitter {
  private values: Record<string, unknown>;
  private userValues: Record<string, unknown> = {};
  private workspaceValues: Record<string, unknown> = {};
  private workspaceFilePath: string | null = null;
  /** Coalesces writes to the advanced-settings file. */
  private fileWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private fileWriter: ((values: Record<string, unknown>) => Promise<unknown>) | null = null;

  constructor() {
    super();
    this.values = defaultSettingsRecord();
    this.loadUser();
  }

  // ------------------------------------------------------------------ reads

  /** Typed access by dotted key, e.g. `get2('editor.tabSize')`. */
  public getValue<T = unknown>(key: string): T {
    const value = this.values[key];
    if (value !== undefined) return value as T;
    const descriptor = schemaByKey.get(key);
    return descriptor?.default as T;
  }

  /**
   * Section access, preserved for the existing call sites.
   * `settingsManager.get('formatting').alignAmpersands`
   */
  public get<K extends string>(section: K): Record<string, unknown> {
    const prefix = `${section}.`;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.values)) {
      if (key.startsWith(prefix)) result[key.slice(prefix.length)] = value;
    }
    return result;
  }

  /** All values as a plain object keyed by dotted path. */
  public getAll(): Record<string, unknown> {
    return { ...this.values };
  }

  /** Which scope currently wins for a key. */
  public getScope(key: string): SettingScope {
    if (key in this.workspaceValues) return 'workspace';
    if (key in this.userValues) return 'user';
    return 'default';
  }

  /** Looks up the descriptor for a settings key, if declared. */
  public getDescriptor(key: string): SettingDescriptor | undefined {
    return schemaByKey.get(key);
  }

  public getWorkspaceFilePath(): string | null {
    return this.workspaceFilePath;
  }

  // ----------------------------------------------------------------- writes

  /**
   * Refuses a workspace write to a setting the project does not own.
   *
   * Only the *workspace* scope is policed, and only for a key the schema
   * declares: `keybindings.<command>` and anything else the schema does not name
   * is the advanced-settings file's escape hatch, and the user scope is where it
   * belongs (see `canBeProjectScoped`). A caller that asks for the wrong scope is
   * a bug in the caller — silently writing to the user's file instead would put a
   * value somewhere nobody asked for it — so this throws, exactly as an invalid
   * value does.
   */
  private assertWritableAtScope(key: string, scope: SettingScope): void {
    if (scope !== 'workspace') return;
    if (schemaByKey.has(key) && !canBeProjectScoped(key)) {
      throw new Error(
        `Setting "${key}" is a user setting and cannot be set for one project. ` +
          `Set it at user scope; a project may only set: ${PROJECT_SCOPED_SETTINGS.join(', ')}.`
      );
    }
  }

  public setValue(key: string, value: unknown, scope: SettingScope = 'user'): void {
    const error = validateSettingValue(key, value);
    if (error) {
      throw new Error(`Invalid value for setting "${key}": ${error}`);
    }
    this.assertWritableAtScope(key, scope);
    const store = scope === 'workspace' ? this.workspaceValues : scope === 'user' ? this.userValues : null;
    if (!store) {
      this.values[key] = value;
    } else {
      store[key] = value;
      this.recompute();
    }
    if (scope !== 'workspace') this.saveUser();
    this.emit('change', { key, value, scope });
    // The advanced-settings file is the durable copy: the settings UI and the
    // JSON file must never disagree about what the user chose.
    if (scope === 'user') this.scheduleFileWrite();
  }

  /** Section-shaped write, preserved for the existing call sites. */
  public set(section: string, values: Record<string, unknown>, scope: SettingScope = 'user'): void {
    for (const [shortKey, value] of Object.entries(values)) {
      const fullKey = `${section}.${shortKey}`;
      const error = validateSettingValue(fullKey, value);
      if (error) throw new Error(`Invalid value for setting "${fullKey}": ${error}`);
      this.assertWritableAtScope(fullKey, scope);
      const store = scope === 'workspace' ? this.workspaceValues : this.userValues;
      store[fullKey] = value;
    }
    this.recompute();
    if (scope !== 'workspace') this.saveUser();
    this.emit('change', { section, values, scope });
  }

  /** Reset one key, or a whole section when `key` names a section. */
  public reset(key: string, scope: SettingScope = 'user'): void {
    this.assertWritableAtScope(key, scope);
    const store = scope === 'workspace' ? this.workspaceValues : this.userValues;
    if (schemaByKey.has(key)) {
      delete store[key];
    } else {
      const prefix = `${key}.`;
      for (const k of Object.keys(store)) if (k.startsWith(prefix)) delete store[k];
    }
    this.recompute();
    if (scope !== 'workspace') this.saveUser();
    this.emit('change', { key, scope, reset: true });
  }

  public resetAll(scope: SettingScope = 'user'): void {
    if (scope === 'workspace') this.workspaceValues = {};
    else this.userValues = {};
    this.recompute();
    if (scope !== 'workspace') this.saveUser();
    this.emit('change', { scope, resetAll: true });
  }

  /**
   * Apply a workspace-level (project) settings file.
   *
   * A key the project does not own is dropped rather than applied, which is what
   * makes `PROJECT_SCOPED_SETTINGS` the list of settings a project can carry
   * rather than a list of the ones somebody remembered to check. The file still
   * holds whatever the author wrote — the application does not rewrite it — so a
   * reader can see what the project asked for and the answer is simply that the
   * editor's font size is the user's.
   */
  public loadWorkspaceSettings(filePath: string | null, values: Record<string, unknown> | null): void {
    this.workspaceFilePath = filePath;
    this.workspaceValues = {};
    if (values) {
      for (const [key, value] of Object.entries(values)) {
        if (canBeProjectScoped(key) && !validateSettingValue(key, value)) {
          this.workspaceValues[key] = value;
        }
      }
    }
    this.recompute();
    this.emit('change', { workspace: true, filePath });
  }

  // ------------------------------------------------- advanced settings files

  /**
   * Applies values read from an advanced-settings JSON file.
   *
   * Unlike {@link setValue} these are not rejected by the schema: the whole
   * point of the file is to hold keys the schema does not name — a per-command
   * keybinding, an experimental flag. A value that *is* in the schema still has
   * to type-check, so a typo in a known key is reported rather than silently
   * accepted, and unknown keys are kept so they survive a round-trip.
   *
   * The one thing a *workspace* file cannot do is set a setting the project does
   * not own; see {@link loadWorkspaceSettings} and `canBeProjectScoped`.
   */
  public applyAdvancedSettings(
    values: Record<string, unknown> | null,
    scope: 'user' | 'workspace' = 'user'
  ): void {
    const store = scope === 'workspace' ? this.workspaceValues : this.userValues;
    // Disk is authoritative for either scope; removed keys must not survive in
    // localStorage or leak from a previously selected project library.
    for (const key of Object.keys(store)) delete store[key];
    /**
     * Keys the file set and the project does not own.
     *
     * Collected rather than warned about one at a time, and reported in one line
     * after the loop: this runs whenever the watched project file changes, so a
     * file with a handful of user settings in it would otherwise fill the console
     * on every save. The line is what makes the old behaviour discoverable — a
     * setting that used to apply from a project file now does nothing, and the
     * only place that can say why is here.
     */
    const userOnly: string[] = [];
    if (values) {
      for (const [key, value] of Object.entries(values)) {
        if (scope === 'workspace' && !canBeProjectScoped(key)) {
          userOnly.push(key);
          continue;
        }
        const error = validateSettingValue(key, value);
        if (error) {
          console.warn(`[eukolia] ignoring setting "${key}" from ${scope} settings: ${error}`);
          continue;
        }
        store[key] = value;
      }
    }
    if (userOnly.length > 0) {
      console.warn(
        `[eukolia] ignoring ${userOnly.length} user setting(s) in the project settings: ` +
          `${userOnly.join(', ')}. These apply to every project and belong in the user settings.`
      );
    }
    this.recompute();
    if (scope === 'user') this.saveUser();
    this.emit('change', { advanced: true, scope });
  }

  /** The values that belong in the user-scope advanced-settings file. */
  public advancedSettingsValues(scope: 'user' | 'workspace' = 'user'): Record<string, unknown> {
    return scope === 'workspace' ? { ...this.workspaceValues } : { ...this.userValues };
  }

  /**
   * Called after any change so the advanced-settings file tracks the settings
   * UI. Persisting is coalesced: dragging a slider must not write a file per
   * pixel.
   */
  private scheduleFileWrite(): void {
    if (this.fileWriteTimer !== null) return;
    this.fileWriteTimer = setTimeout(() => {
      this.fileWriteTimer = null;
      void this.fileWriter?.(this.advancedSettingsValues('user'));
    }, 250);
  }

  /** Installs the writer used to persist settings to the JSON file. */
  public setFileWriter(writer: ((values: Record<string, unknown>) => Promise<unknown>) | null): void {
    this.fileWriter = writer;
  }

  /** Flushes a pending write immediately; used before the window closes. */
  public async flushFileWrite(): Promise<void> {
    if (this.fileWriteTimer === null) return;
    clearTimeout(this.fileWriteTimer);
    this.fileWriteTimer = null;
    await this.fileWriter?.(this.advancedSettingsValues('user'));
  }

  // -------------------------------------------------------------- searching

  /** Fuzzy-ish search across key, label, category, description and keywords. */
  public search(query: string): SettingDescriptor[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [...SETTINGS_SCHEMA];
    const scored: Array<{ descriptor: SettingDescriptor; score: number }> = [];
    for (const descriptor of SETTINGS_SCHEMA) {
      const haystack = [
        descriptor.key,
        descriptor.label,
        descriptor.category,
        descriptor.description ?? '',
        ...(descriptor.keywords ?? [])
      ]
        .join(' ')
        .toLowerCase();
      let score = 0;
      let matchedAll = true;
      for (const term of terms) {
        if (descriptor.key.toLowerCase().includes(term)) score += 6;
        else if (descriptor.label.toLowerCase().includes(term)) score += 4;
        else if (haystack.includes(term)) score += 2;
        else matchedAll = false;
      }
      if (matchedAll && score > 0) scored.push({ descriptor, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.descriptor);
  }

  /** Settings grouped by category, for the settings UI. */
  public byCategory(): Array<{ category: string; settings: SettingDescriptor[] }> {
    return SETTING_CATEGORIES.map((category) => ({
      category,
      settings: SETTINGS_SCHEMA.filter((d) => d.category === category)
    })).filter((group) => group.settings.length > 0);
  }

  /**
   * Bridge for ported VS Code extension code: resolves a `section.key` pair that
   * the reference project would have read from `workspace.getConfiguration`.
   */
  public getForVscode(section: string, key: string): unknown {
    const requested = section ? `${section}.${key}` : key;
    const byVscode = SETTINGS_SCHEMA.find((d) => d.vscodeKey === requested || d.vscodeKey === key);
    if (byVscode && this.values[byVscode.key] !== undefined) return this.values[byVscode.key];
    if (this.values[requested] !== undefined) return this.values[requested];
    // Fall back to a direct lookup on the short key so hsnips.*/texAligner.* style
    // keys keep resolving even before every one has an explicit mapping.
    const suffixMatches = Object.keys(this.values).filter((k) => k.endsWith(`.${key}`));
    if (suffixMatches.length === 1) return this.values[suffixMatches[0]];
    return undefined;
  }

  // ---------------------------------------------------------------- private

  private recompute(): void {
    const next = defaultSettingsRecord();
    for (const [key, value] of Object.entries(this.userValues)) next[key] = value;
    for (const [key, value] of Object.entries(this.workspaceValues)) next[key] = value;
    this.values = next;
  }

  private loadUser(): void {
    try {
      const stored = localStorage.getItem('eukolia.settings.user');
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (value !== undefined) this.userValues[key] = value;
        }
      } else {
        // Migrate the legacy single-blob format written by earlier versions.
        const legacy = localStorage.getItem('eukolia_settings');
        if (legacy) {
          const parsed = JSON.parse(legacy) as Record<string, Record<string, unknown>>;
          for (const [section, sectionValues] of Object.entries(parsed)) {
            if (sectionValues && typeof sectionValues === 'object') {
              for (const [key, value] of Object.entries(sectionValues)) {
                const fullKey = `${section}.${key}`;
                if (schemaByKey.has(fullKey)) this.userValues[fullKey] = value;
              }
            }
          }
          this.saveUser();
        }
      }
    } catch {
      this.userValues = {};
    }
    this.recompute();
  }

  private saveUser(): void {
    try {
      localStorage.setItem('eukolia.settings.user', JSON.stringify(this.userValues));
    } catch {
      /* storage may be unavailable; settings still work for this session */
    }
  }
}

export const settingsManager = new SettingsManager();

// ---------------------------------------------------------------------------
// Convenience typed accessors used across the app.
// ---------------------------------------------------------------------------

export const setting = {
  bool: (key: string): boolean => Boolean(settingsManager.getValue(key)),
  num: (key: string): number => Number(settingsManager.getValue(key)),
  str: (key: string): string => String(settingsManager.getValue(key)),
  list: (key: string): string[] => {
    const value = settingsManager.getValue(key);
    return Array.isArray(value) ? (value as string[]) : [];
  },
  /**
   * The directories project search skips.
   *
   * VS Code's `search.exclude` "Inherits all glob patterns from the `files.exclude`
   * setting", and the search service merges the two with the search-specific value
   * winning where they disagree (`search.ts`, `getExcludes`). In a list of names
   * that merge is a union, and it lives here rather than at the call site so the
   * rule is stated once and can be tested without a window.
   */
  searchExcludeDirectories: (): string[] => [
    ...setting.list('files.exclude'),
    ...setting.list('search.exclude')
  ]
};

export type EukoliaSettings = Record<string, unknown>;
export const DEFAULT_SETTINGS = defaultSettingsRecord();
