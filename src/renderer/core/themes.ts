/**
 * Eukolia themes.
 *
 * Two hand-tuned themes plus a "follow the system" mode (Instructions.md §52).
 * A theme supplies every token the application needs — chrome, editor, visual
 * editor, diagnostics, PDF backdrop and LaTeX syntax colours — and is applied by
 * writing CSS custom properties, so components never hard-code colours.
 */

/**
 * The available themes.
 *
 * `dark` and `light` are the two full definitions; every other theme names one of
 * them as its base and overrides only the colours it changes.
 */
export type ThemeName =
  | 'light'
  | 'dark'
  | 'solarized-light'
  | 'solarized-dark'
  | 'nord'
  | 'gruvbox-dark'
  | 'one-dark'
  | 'catppuccin-latte';

/** A theme choice, which may defer to the operating system. */
export type ThemeSetting = ThemeName | 'system';
/** The resolved appearance of a theme, used where only light/dark matters. */
export type ThemeAppearance = 'light' | 'dark';

export interface SyntaxTokens {
  /** `\command`, `\begin`, `\end`. */
  command: string;
  /** Environment names inside braces. */
  environment: string;
  /** `{...}` and `[...]` delimiters. */
  brace: string;
  /** `%` comments. */
  comment: string;
  /** `$...$`, `\[...\]`. */
  mathDelimiter: string;
  /** Math-mode content. */
  math: string;
  /** `\label{...}` values. */
  label: string;
  /** `\ref{...}` / `\eqref{...}` values. */
  reference: string;
  /** `\cite{...}` values. */
  citation: string;
  /** Paths in `\input`, `\include`, `\includegraphics`. */
  filePath: string;
  /** `\newcommand`-style definitions. */
  macroDefinition: string;
  /** Numbers and units. */
  number: string;
  /** `&`, `\\`, `_`, `^`, `#`, `$` control characters. */
  operator: string;
  /** Plain text and prose. */
  text: string;
  /** Optional-argument brackets. */
  optional: string;
  /** Programming keywords (const, let, function, if, return, import, class). */
  keyword: string;
  /** Function names, declarations and calls. */
  function: string;
  /** String literals in code. */
  string: string;
  /** Property names, object keys in JSON / JS. */
  property: string;
  /** Constants, booleans (true/false), null, undefined. */
  constant: string;
  /** Variable identifiers. */
  variable: string;
  /** Variable definitions/declarations. */
  variableDef: string;
  /** Class and type names. */
  className: string;
  /** Markdown headings. */
  heading: string;
  /** Links and URLs. */
  link: string;
  /** Inline code and code block text. */
  monospace: string;
}

export interface ThemeTokens {
  name: ThemeName;
  /** True when the theme is dark, used to pick default PDF inversion. */
  dark: boolean;

  // Chrome
  bgApp: string;
  bgSidebar: string;
  bgToolbar: string;
  bgPanel: string;
  bgCard: string;
  bgHover: string;
  bgActive: string;
  bgInput: string;
  bgOverlay: string;

  // Tabs and lists
  bgTabActive: string;
  bgTabInactive: string;
  bgSelectionList: string;

  // Text
  fgPrimary: string;
  fgSecondary: string;
  fgMuted: string;
  fgInverted: string;
  fgLink: string;

  // Lines
  border: string;
  borderStrong: string;
  borderFocus: string;

  // Accent
  accent: string;
  accentHover: string;
  accentMuted: string;
  accentFg: string;

  // Status
  error: string;
  errorBg: string;
  warning: string;
  warningBg: string;
  info: string;
  infoBg: string;
  success: string;
  successBg: string;

  // Editor
  editorBg: string;
  editorFg: string;
  editorLineHighlight: string;
  editorSelection: string;
  editorSelectionMatch: string;
  editorCursor: string;
  /**
   * The caret while mathematics is being edited (Math Mode).
   *
   * The caret has to say which *editing context* is active as well as where
   * insertion happens, and it is the one signal that is always on screen: in
   * Visual Mode the mathematics under the caret is revealed as its LaTeX source,
   * and this is what marks that the source being edited is mathematics and not
   * prose. It is therefore a token of its own rather than a reuse of
   * `editorCursor`.
   */
  editorCursorMath: string;
  editorGutterFg: string;
  editorGutterBg: string;
  editorIndentGuide: string;
  editorBracketMatch: string;
  editorActiveIndentGuide: string;

  // Visual editor
  visualBg: string;
  visualFg: string;
  visualHeadingFg: string;
  visualMathBg: string;
  /**
   * The mathematical source revealed under the caret in Visual Mode. It is
   * *source*, and reads as source: the same face and line height as Code Mode,
   * tinted so that a region being edited is visible as a region.
   */
  visualMathSourceBg: string;
  visualRawLatexBg: string;
  visualRawLatexFg: string;
  visualRawLatexBorder: string;
  visualQuoteBorder: string;

  // PDF
  pdfBackdrop: string;
  pdfShadow: string;
  pdfSyncHighlight: string;

  syntax: SyntaxTokens;
}

export const DARK_THEME: ThemeTokens = {
  name: 'dark',
  dark: true,

  bgApp: '#0e1017',
  bgSidebar: '#12141c',
  bgToolbar: '#161923',
  bgPanel: '#12141c',
  bgCard: '#181b25',
  bgHover: '#1e2230',
  bgActive: '#232838',
  bgInput: '#0b0d13',
  bgOverlay: 'rgba(6, 8, 12, 0.62)',

  bgTabActive: '#0e1017',
  bgTabInactive: '#161923',
  bgSelectionList: '#1b2030',

  fgPrimary: '#e8ecf4',
  fgSecondary: '#a2acc0',
  fgMuted: '#6e7889',
  fgInverted: '#0e1017',
  fgLink: '#6aa6ff',

  border: '#232838',
  borderStrong: '#333a4e',
  borderFocus: '#3d7dff',

  accent: '#3d7dff',
  accentHover: '#5a92ff',
  accentMuted: 'rgba(61, 125, 255, 0.16)',
  accentFg: '#ffffff',

  error: '#ff6b6b',
  errorBg: 'rgba(255, 107, 107, 0.14)',
  warning: '#f0b429',
  warningBg: 'rgba(240, 180, 41, 0.14)',
  info: '#4dabf7',
  infoBg: 'rgba(77, 171, 247, 0.14)',
  success: '#37b24d',
  successBg: 'rgba(55, 178, 77, 0.14)',

  editorBg: '#0e1017',
  editorFg: '#e8ecf4',
  editorLineHighlight: '#141824',
  editorSelection: '#26406e',
  editorSelectionMatch: '#1f3355',
  editorCursor: '#7db2ff',
  editorCursorMath: '#f0b429',
  editorGutterFg: '#4d5668',
  editorGutterBg: '#0e1017',
  editorIndentGuide: '#1c2130',
  editorBracketMatch: '#2f4a7a',
  editorActiveIndentGuide: '#2b3348',

  visualBg: '#12141c',
  visualFg: '#e8ecf4',
  visualHeadingFg: '#ffffff',
  visualMathBg: 'rgba(61, 125, 255, 0.07)',
  visualMathSourceBg: 'rgba(240, 180, 41, 0.10)',
  visualRawLatexBg: 'rgba(240, 180, 41, 0.08)',
  visualRawLatexFg: '#e2c07a',
  visualRawLatexBorder: 'rgba(240, 180, 41, 0.35)',
  visualQuoteBorder: '#3d7dff',

  pdfBackdrop: '#1a1d26',
  pdfShadow: 'rgba(0, 0, 0, 0.55)',
  pdfSyncHighlight: 'rgba(61, 125, 255, 0.35)',

  syntax: {
    command: '#7db2ff',
    environment: '#ff8fc7',
    brace: '#f0c674',
    comment: '#5c6675',
    mathDelimiter: '#37d3a6',
    math: '#4fe0b5',
    label: '#c39bff',
    reference: '#8ad4ff',
    citation: '#ffb35c',
    filePath: '#8fd67a',
    macroDefinition: '#ffa8e0',
    number: '#f2b880',
    operator: '#d8a0ff',
    text: '#e8ecf4',
    optional: '#b8b2ff',
    keyword: '#ff7b72',
    function: '#61afef',
    string: '#7ee787',
    property: '#79c0ff',
    constant: '#ff9e64',
    variable: '#e8ecf4',
    variableDef: '#ffa657',
    className: '#4ec9b0',
    heading: '#ff79c6',
    link: '#58a6ff',
    monospace: '#f1fa8c'
  }
};

export const LIGHT_THEME: ThemeTokens = {
  name: 'light',
  dark: false,

  bgApp: '#f6f7f9',
  bgSidebar: '#eef0f4',
  bgToolbar: '#eceef2',
  bgPanel: '#f2f4f7',
  bgCard: '#ffffff',
  bgHover: '#e4e8ef',
  bgActive: '#dbe1ea',
  bgInput: '#ffffff',
  bgOverlay: 'rgba(24, 28, 36, 0.28)',

  bgTabActive: '#ffffff',
  bgTabInactive: '#e7eaf0',
  bgSelectionList: '#dde5f5',

  fgPrimary: '#161a22',
  fgSecondary: '#4a5262',
  fgMuted: '#7c8494',
  fgInverted: '#ffffff',
  fgLink: '#1a5fd0',

  border: '#d5dae3',
  borderStrong: '#b9c1cf',
  borderFocus: '#1a5fd0',

  accent: '#1a5fd0',
  accentHover: '#2f76e8',
  accentMuted: 'rgba(26, 95, 208, 0.12)',
  accentFg: '#ffffff',

  error: '#c92a2a',
  errorBg: 'rgba(201, 42, 42, 0.10)',
  warning: '#a96a00',
  warningBg: 'rgba(169, 106, 0, 0.12)',
  info: '#1565c0',
  infoBg: 'rgba(21, 101, 192, 0.10)',
  success: '#217a36',
  successBg: 'rgba(33, 122, 54, 0.12)',

  editorBg: '#ffffff',
  editorFg: '#161a22',
  editorLineHighlight: '#f3f5f9',
  editorSelection: '#c3d8f7',
  editorSelectionMatch: '#dbe7fa',
  editorCursor: '#1a5fd0',
  editorCursorMath: '#a96a00',
  editorGutterFg: '#98a1b0',
  editorGutterBg: '#ffffff',
  editorIndentGuide: '#e6e9ef',
  editorBracketMatch: '#c3d8f7',
  editorActiveIndentGuide: '#c9cfdb',

  visualBg: '#ffffff',
  visualFg: '#161a22',
  visualHeadingFg: '#0b0e14',
  visualMathBg: 'rgba(26, 95, 208, 0.05)',
  visualMathSourceBg: 'rgba(169, 106, 0, 0.09)',
  visualRawLatexBg: 'rgba(169, 106, 0, 0.07)',
  visualRawLatexFg: '#8a5a00',
  visualRawLatexBorder: 'rgba(169, 106, 0, 0.28)',
  visualQuoteBorder: '#1a5fd0',

  pdfBackdrop: '#dfe3ea',
  pdfShadow: 'rgba(24, 28, 36, 0.22)',
  pdfSyncHighlight: 'rgba(26, 95, 208, 0.28)',

  syntax: {
    command: '#1a5fd0',
    environment: '#b3197a',
    brace: '#9a6b00',
    comment: '#8b93a2',
    mathDelimiter: '#0f8f6c',
    math: '#0b6f54',
    label: '#6b2ec4',
    reference: '#0f6ea8',
    citation: '#a85a00',
    filePath: '#2f7a34',
    macroDefinition: '#b3197a',
    number: '#a05a00',
    operator: '#7b3fbf',
    text: '#161a22',
    optional: '#4b46a8',
    keyword: '#cf222e',
    function: '#005cc5',
    string: '#116329',
    property: '#0550ae',
    constant: '#953800',
    variable: '#161a22',
    variableDef: '#953800',
    className: '#0969da',
    heading: '#cf222e',
    link: '#0969da',
    monospace: '#8250df'
  }
};

/**
 * The built-in themes.
 *
 * `dark` and `light` are the two full definitions; every other theme is written
 * as a set of overrides on one of them, because a theme is a *colour scheme* —
 * a handful of surface, text and syntax colours — and re-stating all sixty-odd
 * tokens per theme would bury those choices in repeated defaults that then drift
 * apart. Anything a theme does not override is inherited from its base, so a new
 * token added to `ThemeTokens` reaches every theme at once.
 */
interface ThemeOverrides extends Partial<Omit<ThemeTokens, 'name' | 'dark' | 'syntax'>> {
  name: ThemeName;
  dark: boolean;
  syntax?: Partial<SyntaxTokens>;
}

const defineTheme = (base: 'light' | 'dark', overrides: ThemeOverrides): ThemeTokens => {
  const parent = base === 'dark' ? DARK_THEME : LIGHT_THEME;
  const { syntax, ...rest } = overrides;
  return {
    ...parent,
    ...rest,
    visualFg: overrides.visualFg ?? overrides.fgPrimary ?? parent.visualFg,
    syntax: { ...parent.syntax, ...(syntax ?? {}) }
  };
};

export const THEMES: Record<ThemeName, ThemeTokens> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,

  // ------------------------------------------------------------- Solarized
  // Ethan Schoonover's Solarized: the same eight accent hues on two base
  // backgrounds, so the light and dark variants stay perceptually paired.
  'solarized-dark': defineTheme('dark', {
    name: 'solarized-dark',
    dark: true,
    bgApp: '#002b36',
    bgSidebar: '#073642',
    bgToolbar: '#073642',
    bgPanel: '#073642',
    bgCard: '#0a4050',
    bgHover: '#0d4c5e',
    bgActive: '#12556a',
    bgInput: '#00252e',
    bgTabActive: '#002b36',
    bgTabInactive: '#073642',
    bgSelectionList: '#0d4c5e',
    fgPrimary: '#eee8d5',
    fgSecondary: '#93a1a1',
    fgMuted: '#657b83',
    fgInverted: '#002b36',
    fgLink: '#268bd2',
    border: '#0d4c5e',
    borderStrong: '#155e70',
    borderFocus: '#268bd2',
    accent: '#268bd2',
    accentHover: '#3a9ee0',
    accentMuted: '#1c5f8a',
    accentFg: '#002b36',
    editorBg: '#002b36',
    editorFg: '#eee8d5',
    editorLineHighlight: '#073642',
    editorSelection: '#0d4c5e',
    editorGutterFg: '#586e75',
    editorGutterBg: '#002b36',
    visualBg: '#002b36',
    syntax: {
      comment: '#586e75',
      command: '#859900',
      environment: '#b58900',
      brace: '#93a1a1',
      mathDelimiter: '#cb4b16',
      math: '#6c71c4',
      label: '#d33682',
      reference: '#2aa198',
      citation: '#268bd2',
      filePath: '#2aa198',
      macroDefinition: '#d33682',
      number: '#cb4b16',
      operator: '#859900',
      text: '#eee8d5',
      optional: '#268bd2'
    }
  }),

  'solarized-light': defineTheme('light', {
    name: 'solarized-light',
    dark: false,
    bgApp: '#fdf6e3',
    bgSidebar: '#eee8d5',
    bgToolbar: '#eee8d5',
    bgPanel: '#eee8d5',
    bgCard: '#f7f0dd',
    bgHover: '#e6dfc8',
    bgActive: '#ddd6bf',
    bgInput: '#fffbf0',
    bgTabActive: '#fdf6e3',
    bgTabInactive: '#eee8d5',
    bgSelectionList: '#e6dfc8',
    fgPrimary: '#073642',
    fgSecondary: '#586e75',
    fgMuted: '#93a1a1',
    fgInverted: '#fdf6e3',
    fgLink: '#268bd2',
    border: '#e0d9c3',
    borderStrong: '#cfc7ae',
    borderFocus: '#268bd2',
    accent: '#268bd2',
    accentHover: '#1f7ab8',
    accentMuted: '#a8cbe6',
    accentFg: '#fdf6e3',
    editorBg: '#fdf6e3',
    editorFg: '#073642',
    editorLineHighlight: '#f2ebd8',
    editorSelection: '#dfe8d8',
    editorGutterFg: '#93a1a1',
    editorGutterBg: '#fdf6e3',
    visualBg: '#fdf6e3',
    syntax: {
      comment: '#93a1a1',
      command: '#859900',
      environment: '#b58900',
      brace: '#586e75',
      mathDelimiter: '#cb4b16',
      math: '#6c71c4',
      label: '#d33682',
      reference: '#2aa198',
      citation: '#268bd2',
      filePath: '#2aa198',
      macroDefinition: '#d33682',
      number: '#cb4b16',
      operator: '#859900',
      text: '#073642',
      optional: '#268bd2'
    }
  }),

  // ------------------------------------------------------------------ Nord
  // Arctic, blue-grey and low contrast: `nord0`–`nord3` for surfaces, `nord4`–
  // `nord6` for text, `nord7`–`nord15` for the syntax accents.
  nord: defineTheme('dark', {
    name: 'nord',
    dark: true,
    bgApp: '#2e3440',
    bgSidebar: '#292e39',
    bgToolbar: '#3b4252',
    bgPanel: '#292e39',
    bgCard: '#3b4252',
    bgHover: '#434c5e',
    bgActive: '#4c566a',
    bgInput: '#272c36',
    bgTabActive: '#2e3440',
    bgTabInactive: '#3b4252',
    bgSelectionList: '#434c5e',
    fgPrimary: '#eceff4',
    fgSecondary: '#d8dee9',
    fgMuted: '#7b88a1',
    fgInverted: '#2e3440',
    fgLink: '#88c0d0',
    border: '#3b4252',
    borderStrong: '#4c566a',
    borderFocus: '#88c0d0',
    accent: '#88c0d0',
    accentHover: '#9ed3e0',
    accentMuted: '#5e81ac',
    accentFg: '#2e3440',
    editorBg: '#2e3440',
    editorFg: '#d8dee9',
    editorLineHighlight: '#3b4252',
    editorSelection: '#434c5e',
    editorGutterFg: '#616e88',
    editorGutterBg: '#2e3440',
    visualBg: '#2e3440',
    syntax: {
      comment: '#616e88',
      command: '#81a1c1',
      environment: '#8fbcbb',
      brace: '#d8dee9',
      mathDelimiter: '#b48ead',
      math: '#b48ead',
      label: '#ebcb8b',
      reference: '#a3be8c',
      citation: '#88c0d0',
      filePath: '#a3be8c',
      macroDefinition: '#d08770',
      number: '#b48ead',
      operator: '#81a1c1',
      text: '#d8dee9',
      optional: '#5e81ac'
    }
  }),

  // -------------------------------------------------------------- Gruvbox
  'gruvbox-dark': defineTheme('dark', {
    name: 'gruvbox-dark',
    dark: true,
    bgApp: '#282828',
    bgSidebar: '#1d2021',
    bgToolbar: '#3c3836',
    bgPanel: '#1d2021',
    bgCard: '#3c3836',
    bgHover: '#504945',
    bgActive: '#665c54',
    bgInput: '#1d2021',
    bgTabActive: '#282828',
    bgTabInactive: '#3c3836',
    bgSelectionList: '#504945',
    fgPrimary: '#ebdbb2',
    fgSecondary: '#d5c4a1',
    fgMuted: '#928374',
    fgInverted: '#282828',
    fgLink: '#83a598',
    border: '#3c3836',
    borderStrong: '#504945',
    borderFocus: '#fabd2f',
    accent: '#fabd2f',
    accentHover: '#ffd35c',
    accentMuted: '#b57614',
    accentFg: '#282828',
    editorBg: '#282828',
    editorFg: '#ebdbb2',
    editorLineHighlight: '#32302f',
    editorSelection: '#504945',
    editorGutterFg: '#7c6f64',
    editorGutterBg: '#282828',
    visualBg: '#282828',
    syntax: {
      comment: '#928374',
      command: '#fb4934',
      environment: '#fabd2f',
      brace: '#ebdbb2',
      mathDelimiter: '#d3869b',
      math: '#d3869b',
      label: '#8ec07c',
      reference: '#83a598',
      citation: '#83a598',
      filePath: '#b8bb26',
      macroDefinition: '#d3869b',
      number: '#d3869b',
      operator: '#fe8019',
      text: '#ebdbb2',
      optional: '#83a598'
    }
  }),

  // ------------------------------------------------------------- One Dark
  'one-dark': defineTheme('dark', {
    name: 'one-dark',
    dark: true,
    bgApp: '#282c34',
    bgSidebar: '#21252b',
    bgToolbar: '#21252b',
    bgPanel: '#21252b',
    bgCard: '#2c313a',
    bgHover: '#333842',
    bgActive: '#3b4048',
    bgInput: '#1b1e24',
    bgTabActive: '#282c34',
    bgTabInactive: '#21252b',
    bgSelectionList: '#333842',
    fgPrimary: '#abb2bf',
    fgSecondary: '#9da5b4',
    fgMuted: '#5c6370',
    fgInverted: '#282c34',
    fgLink: '#61afef',
    border: '#333842',
    borderStrong: '#3b4048',
    borderFocus: '#61afef',
    accent: '#61afef',
    accentHover: '#7cc0f5',
    accentMuted: '#3d7ab5',
    accentFg: '#282c34',
    editorBg: '#282c34',
    editorFg: '#abb2bf',
    editorLineHighlight: '#2c313a',
    editorSelection: '#3e4451',
    editorGutterFg: '#4b5263',
    editorGutterBg: '#282c34',
    visualBg: '#282c34',
    syntax: {
      comment: '#5c6370',
      command: '#c678dd',
      environment: '#e5c07b',
      brace: '#abb2bf',
      mathDelimiter: '#56b6c2',
      math: '#d19a66',
      label: '#e06c75',
      reference: '#98c379',
      citation: '#61afef',
      filePath: '#98c379',
      macroDefinition: '#e06c75',
      number: '#d19a66',
      operator: '#56b6c2',
      text: '#abb2bf',
      optional: '#61afef',
      keyword: '#c678dd',
      function: '#61afef',
      string: '#98c379',
      property: '#e06c75',
      constant: '#d19a66',
      className: '#e5c07b',
      heading: '#e06c75',
      monospace: '#e5c07b'
    }
  }),

  // ---------------------------------------------------------- Catppuccin
  'catppuccin-latte': defineTheme('light', {
    name: 'catppuccin-latte',
    dark: false,
    bgApp: '#eff1f5',
    bgSidebar: '#e6e9ef',
    bgToolbar: '#e6e9ef',
    bgPanel: '#e6e9ef',
    bgCard: '#ffffff',
    bgHover: '#dce0e8',
    bgActive: '#ccd0da',
    bgInput: '#ffffff',
    bgTabActive: '#eff1f5',
    bgTabInactive: '#e6e9ef',
    bgSelectionList: '#dce0e8',
    fgPrimary: '#4c4f69',
    fgSecondary: '#5c5f77',
    fgMuted: '#8c8fa1',
    fgInverted: '#eff1f5',
    fgLink: '#1e66f5',
    border: '#dce0e8',
    borderStrong: '#ccd0da',
    borderFocus: '#1e66f5',
    accent: '#1e66f5',
    accentHover: '#3b7bf7',
    accentMuted: '#9db8f8',
    accentFg: '#ffffff',
    editorBg: '#eff1f5',
    editorFg: '#4c4f69',
    editorLineHighlight: '#e6e9ef',
    editorSelection: '#ccd0da',
    editorGutterFg: '#9ca0b0',
    editorGutterBg: '#eff1f5',
    visualBg: '#eff1f5',
    syntax: {
      comment: '#8c8fa1',
      command: '#8839ef',
      environment: '#df8e1d',
      brace: '#5c5f77',
      mathDelimiter: '#179299',
      math: '#7287fd',
      label: '#d20f39',
      reference: '#40a02b',
      citation: '#1e66f5',
      filePath: '#40a02b',
      macroDefinition: '#e64553',
      number: '#fe640b',
      operator: '#04a5e5',
      text: '#4c4f69',
      optional: '#1e66f5'
    }
  })
};

/** CSS custom property name for each token. Kept flat so themes are easy to extend. */
function tokenPairs(tokens: ThemeTokens): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(tokens)) {
    if (key === 'name' || key === 'dark' || key === 'syntax') continue;
    pairs.push([`--eu-${kebab(key)}`, String(value)]);
  }
  for (const [key, value] of Object.entries(tokens.syntax)) {
    pairs.push([`--eu-syntax-${kebab(key)}`, value]);
  }
  return pairs;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/**
 * The themes a user can pick, in the order the settings list shows them: the two
 * defaults first, then the rest.
 */
export const THEME_NAMES = [
  'dark',
  'light',
  'solarized-dark',
  'solarized-light',
  'nord',
  'gruvbox-dark',
  'one-dark',
  'catppuccin-latte'
] as const satisfies readonly ThemeName[];

/** Human-readable label for a theme, used by settings and the status bar. */
export const THEME_LABELS: Record<ThemeName, string> = {
  dark: 'Eukolia Dark',
  light: 'Eukolia Light',
  'solarized-dark': 'Solarized Dark',
  'solarized-light': 'Solarized Light',
  nord: 'Nord',
  'gruvbox-dark': 'Gruvbox Dark',
  'one-dark': 'One Dark',
  'catppuccin-latte': 'Catppuccin Latte'
};

/**
 * The syntax colours a theme gives the *editor* are not built here.
 *
 * Monaco needed a theme definition of its own (`MONACO_THEME` /
 * `toMonacoTheme`), because its colouring is engine-side. The CodeMirror editor
 * reads the same tokens through the CSS custom properties `ThemeManager.apply`
 * sets on the document element — `--eu-syntax-*`, see
 * `visual/syntaxHighlighting.ts` — so both modes follow the active theme with
 * nothing to keep in sync.
 */

export class ThemeManager {
  private setting: ThemeSetting = 'system';
  private resolved: ThemeName = 'dark';
  private readonly listeners = new Set<(theme: ThemeName) => void>();
  private mediaQuery: MediaQueryList | null = null;
  private applied = false;

  constructor() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (this.setting === 'system') this.apply('system');
      };
      // `addEventListener` is the modern API; older Chromium builds need `addListener`.
      if ('addEventListener' in this.mediaQuery) this.mediaQuery.addEventListener('change', onChange);
      else (this.mediaQuery as MediaQueryList & { addListener(fn: () => void): void }).addListener(onChange);
    }
  }

  public apply(theme: ThemeSetting): ThemeName {
    this.setting = theme;
    this.resolved = theme === 'system' ? (this.mediaQuery?.matches ? 'dark' : 'light') : theme;
    const tokens = THEMES[this.resolved];

    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      for (const [property, value] of tokenPairs(tokens)) {
        root.style.setProperty(property, value);
      }
      // `color-scheme` is what tells the browser to draw scrollbars, form
      // controls and the default canvas light or dark; every theme therefore
      // states its own appearance rather than ever inheriting the other's.
      root.style.colorScheme = tokens.dark ? 'dark' : 'light';
      // The class and the attribute carry the *name* so a stylesheet can target
      // one theme, plus an `is-dark`/`is-light` class for the two-case rules.
      root.classList.remove('theme-dark', 'theme-light');
      root.classList.add(tokens.dark ? 'theme-dark' : 'theme-light');
      root.dataset.theme = this.resolved;
      root.dataset.themeAppearance = tokens.dark ? 'dark' : 'light';
    }

    this.applied = true;
    for (const listener of this.listeners) {
      try {
        listener(this.resolved);
      } catch (err) {
        console.error('[eukolia] theme listener threw', err);
      }
    }
    return this.resolved;
  }

  /** Cycles to the next theme; used by the status bar's theme control. */
  public cycle(): ThemeName {
    const index = THEME_NAMES.indexOf(this.getActiveTheme());
    return this.apply(THEME_NAMES[(index + 1) % THEME_NAMES.length]);
  }

  public getActiveTheme(): ThemeName {
    if (!this.applied) this.apply(this.setting);
    return this.resolved;
  }

  /**
   * The active theme's light/dark appearance.
   *
   * Parts of the app only distinguish two cases — the ported Overleaf editor
   * theme, the PDF pane's light-pdf theme, the default PDF colour inversion — so
   * they take this rather than the theme name, and every theme works with them
   * without knowing about each other.
   */
  public getAppearance(): ThemeAppearance {
    return THEMES[this.getActiveTheme()].dark ? 'dark' : 'light';
  }

  public getSetting(): ThemeSetting {
    return this.setting;
  }

  public getTokens(): ThemeTokens {
    return THEMES[this.getActiveTheme()];
  }

  public onChange(listener: (theme: ThemeName) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public toggle(): ThemeName {
    return this.apply(this.getActiveTheme() === 'dark' ? 'light' : 'dark');
  }

  /** Populates `<meta name="theme-color">` for the window chrome. */
  public updateMetaThemeColor(): void {
    if (typeof document === 'undefined') return;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', this.getTokens().bgApp);
  }
}

export const themeManager = new ThemeManager();
