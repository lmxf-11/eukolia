/**
 * Eukolia service bootstrap.
 *
 * The single place where ported reference subsystems are connected to Eukolia's
 * own services, so callers depend on interfaces rather than on vendored code.
 *
 * Wired here:
 *  - the `vscode` compatibility host that ported extension code talks to;
 *  - the LaTeX Workshop build recipe / plan resolver;
 *  - the HyperSnips snippet engine (sources, context, variables);
 *  - the theme.
 */

import path from 'path';

import { absoluteOutputDirectory, resolveBuildRequest } from '../compiler/buildRequest';
import { parseLatexLogFull } from '../compiler/logParser';
import { recipeConfigs, recipeForEngine, toolsWithOptions } from '../compiler/recipeCatalog';
import type { FileProvider, RecipeConfig, Tool } from '../vendor/latex-workshop/types';
import { setting as lwSetting, type LwSettings, type SettingsProvider } from '../vendor/latex-workshop/settings';

import { projectIndex } from '../document/projectIndex';
import { THEME_NAMES, type ThemeName, type ThemeSetting } from '../core/themes';
import { settingsManager, setting, keybindingSettingFor } from '../core/settings';
import { commandRegistry, commandCatalog } from '../core/commands';
import { buildService, type RecipeCatalog } from './build';
import { workspaceService } from './instance';
import { getSnippetEngine } from '../snippets/engine';
import { rememberExpansion } from '../snippets/history';
import { getSnippetStore } from '../snippets/store';
import { setMultiLineContext } from '../vendor/hypersnips';
import { installVscodeHost } from '../vendor/vscode-shim';
import { createVscodeHostBridge } from './vscodeHost';
import { themeManager } from '../core/themes';
import { startupMark } from '../core/startupProbe';
import type { BuildRequest } from '../../shared/ipc';

let bootstrapped = false;
let readyPromise: Promise<void> | null = null;

/**
 * Connects every ported subsystem to Eukolia. Safe to call more than once.
 *
 * Two halves, and the split is the point. Everything before the returned promise
 * is synchronous and cheap, and it is what the first paint needs: the theme (the
 * shell renders in its colours), the `vscode` host the ported extension code
 * talks to, the build recipes, the keybinding resolver and the settings files
 * (read asynchronously, and each only *adds* to the defaults). The snippet
 * library is a file read nothing on the opening screen uses, so it is the
 * returned promise — `servicesReady()` for callers that cannot do without it, and
 * ignored by callers that can.
 */
export function bootstrapServices(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = true;
    startupMark('bootstrap:start');

    themeManager.apply(resolveThemeSetting(setting.str('general.theme')));
    themeManager.updateMetaThemeColor();
    themeManager.onChange(() => themeManager.updateMetaThemeColor());

    installVscodeHost(createVscodeHostBridge());

    wireBuildRecipes();
    wireKeybindingSettings();
    wireCommandCatalog();
    wireAdvancedSettings();
  }
  readyPromise ??= wireSnippets().then(
    () => {
      startupMark('bootstrap:done');
    },
    (error) => {
      // A library that will not load must not stop the application: the editor
      // works without snippets, and the manager reports the failure in place.
      console.warn('[eukolia] the snippet library could not be loaded at startup', error);
    }
  );
  return readyPromise;
}

/**
 * The background half of the bootstrap, for callers that cannot do without the
 * snippet library — the snippet manager, an import, a reload after a workspace
 * change.
 */
export function servicesReady(): Promise<void> {
  return readyPromise ?? bootstrapServices();
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/**
 * Coerces a stored theme value into one that exists.
 *
 * The settings can hold a theme name from a build that offered a different set
 * — a settings file carried between machines, or a theme removed later — and an
 * unknown name would leave `THEMES[name]` undefined and the whole shell
 * uncoloured. Falling back to the default is the only safe reading of a value
 * the application does not recognise.
 */
export function resolveThemeSetting(value: unknown): ThemeSetting {
  if (value === 'system') return 'system';
  return THEME_NAMES.includes(value as never) ? (value as ThemeName) : 'dark';
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts and the advanced-settings file
// ---------------------------------------------------------------------------

/**
 * Makes the command registry read its shortcuts from settings.
 *
 * The Settings UI writes `keybindings.*`, and the advanced-settings JSON can
 * hold `keybindings.<command id>` for any command at all, so this is the single
 * place a shortcut is resolved.
 */
export function wireKeybindingSettings(): void {
  commandRegistry.setSettingsResolver((commandId) => {
    const dedicated = keybindingSettingFor(commandId);
    if (dedicated) {
      const value = settingsManager.getValue(dedicated);
      return typeof value === 'string' ? value : undefined;
    }
    // Escape hatch: any command can be rebound from the JSON file even when it
    // has no dedicated setting.
    const generic = settingsManager.getValue(`keybindings.${commandId}`);
    return typeof generic === 'string' ? generic : undefined;
  });

  settingsManager.on('change', () => commandRegistry.refreshKeybindings());
}

/**
 * Announces the shell's command catalogue to the other windows.
 *
 * The Settings window's keyboard-shortcut editor lists every command, and the
 * commands live in *this* window: they are registered by the app shell, which is
 * the one with an editor to edit and a build service to drive. So the shell
 * publishes a catalogue — `{id, title, category, binding, hidden}`, never a
 * handler — and the main process relays it (`IPC.commands`).
 *
 * It is republished on every registration and on every keybinding change, so the
 * Settings window's list grows with the registry rather than being a snapshot
 * frozen at whatever had been registered when it opened. `registered` fires once
 * per command, and a full re-registration would otherwise be a burst of sends;
 * the coalescing below turns that burst into one.
 */
function wireCommandCatalog(): void {
  const publish = () => {
    void window.eukoliaApi?.publishCommandCatalog?.(commandCatalog(commandRegistry.getAll())).catch(() => undefined);
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    // A microtask rather than a timer: registration is synchronous, so every
    // command in one `registerAll` collapses into a single send, and the
    // Settings window is told about the whole table at once rather than
    // re-rendering 90 times.
    queueMicrotask(() => {
      queued = false;
      publish();
    });
  };

  commandRegistry.on('registered', schedule);
  commandRegistry.on('unregistered', schedule);
  commandRegistry.on('keybindings-changed', schedule);
}

/**
 * Connects the settings manager to the advanced-settings JSON files.
 *
 * The user-scope file is the durable record of everything the settings UI
 * changes, and the workspace-scope file lets a project carry its own
 * configuration. Both are read at startup and both are watched, so editing one
 * by hand takes effect without a restart.
 */
export function wireAdvancedSettings(): void {
  const api = typeof window === 'undefined' ? null : window.eukoliaApi;
  if (!api) return;

  settingsManager.setFileWriter((values) =>
    api.writeAdvancedSettings('user', values, projectIndex.getProjectRoot())
  );

  const adopt = (scope: 'user' | 'workspace') => {
    void api
      .readAdvancedSettings(scope, projectIndex.getProjectRoot())
      .then((description) => {
        if (description.error) {
          // "No project is open" is the normal state at startup, not a problem.
          if (description.error !== 'no project is open') {
            console.warn(`[eukolia] ${scope} advanced settings: ${description.error}`);
          }
          return;
        }
        if (description.values) {
          settingsManager.applyAdvancedSettings(description.values, scope);
        }

        // The file is the record of what the user chose. A user who configured
        // Eukolia before it existed — settings only in browser storage, or in the
        // pre-`User` file — gets one written now, so the directory always
        // reflects the running configuration rather than an empty file.
        if (scope === 'user' && !description.exists) {
          void api
            .writeAdvancedSettings('user', settingsManager.advancedSettingsValues('user'), projectIndex.getProjectRoot())
            .catch((error) => console.warn('[eukolia] could not write the user settings file', error));
        }
      })
      .catch((error) => {
        console.warn(`[eukolia] could not read ${scope} advanced settings`, error);
      });
  };

  adopt('user');
  adopt('workspace');

  // A project carries its own settings, so opening one adopts its file. Without
  // this the workspace scope would only ever apply to the project that happened
  // to be open at startup.
  workspaceService.on('change', () => {
    if (lastWorkspaceRoot === projectIndex.getProjectRoot()) return;
    lastWorkspaceRoot = projectIndex.getProjectRoot();
    adopt('workspace');
  });

  api.onAdvancedSettingsChanged((description) => {
    if (description.error) {
      console.warn(`[eukolia] ${description.scope} advanced settings: ${description.error}`);
      return;
    }
    settingsManager.applyAdvancedSettings(description.values, description.scope);
  });
}

/** The project root the workspace settings were last read for. */
let lastWorkspaceRoot: string | null = null;

// ---------------------------------------------------------------------------
// Build recipes
// ---------------------------------------------------------------------------

/**
 * The recipes Eukolia offers, read back out of the settings the plan builder
 * will read.
 *
 * The list is not the catalogue: it is whatever the *effective* `latex.recipes`
 * holds, which is the catalogue unless the user replaced it through the advanced
 * settings file. Deriving it this way is what makes the picker unable to offer a
 * name the resolver would reject, and unable to hide one the user added.
 */
function recipeCatalog(): RecipeCatalog {  return {
    list: () => {
      const settings = lwSettingsProvider();
      const recipes = lwSetting<RecipeConfig[]>(settings, 'latex.recipes');
      const tools = lwSetting<Tool[]>(settings, 'latex.tools');
      return recipes.map((recipe) => {
        const names = recipe.tools.map((tool) => (typeof tool === 'string' ? tool : tool.name));
        const commands: string[] = [];
        for (const name of names) {
          const tool = tools.find((candidate) => candidate.name === name);
          const command = tool?.command ?? name;
          if (!commands.includes(command)) commands.push(command);
        }
        return { name: recipe.name, tools: names, commands, available: true, missing: [] };
      });
    }
  };
}

function wireBuildRecipes(): void {
  buildService.setRecipeCatalog(recipeCatalog());
  buildService.setPlanResolver(resolveBuildPlan);
  // The picker follows the settings: `compilation.recipe` and
  // `compilation.engine` change which recipe is the default, and a user's own
  // `latex.recipes` in the advanced settings file replaces the list outright —
  // which arrives as a settings change rather than at startup.
  settingsManager.on('change', () => buildService.refreshRecipes());
}

/**
 * The absolute directory a build writes into, or `undefined` to write beside the
 * source.
 *
 * `compilation.outputDirectory` is written by a person — `build`, or
 * `../out` — and every consumer of `latex.outDir` resolves it with
 * `path.resolve`, which answers against the *renderer process's* working
 * directory. Resolving it here, against the workspace, is what makes a relative
 * output directory mean what it says.
 *
 * The implementation lives in `compiler/buildRequest.ts`, beside the placeholder
 * expansion it exists for, and is re-exported here because this is where the
 * build is wired.
 */
export { absoluteOutputDirectory };

export interface ResolvedPlan {
  /** The request to execute; null when resolution failed. */
  request: BuildRequest | null;
  recipeName: string;
  error?: string;
  /**
   * Things the resolver had to work around: a tool name in the recipe that does
   * not exist, or a recipe name that had to fall back to another one. The build
   * still runs; the reader is told.
   */
  warnings: string[];
}

/**
 * Resolves a build plan through the ported LaTeX Workshop recipe resolver.
 * Called by the build service immediately before starting a build.
 *
 * `force` is the Rebuild command: every `latexmk` rule runs whatever its
 * timestamps say. It is a property of *this* build, so it travels in the tool
 * list the resolver reads rather than in a settings write.
 */
export async function resolveBuildPlan(
  rootFile: string,
  recipeName: string | null,
  options: { force?: boolean } = {}
): Promise<ResolvedPlan> {
  const workspaceDir = projectIndex.getProjectRoot() ?? undefined;
  const outputDir = absoluteOutputDirectory(setting.str('compilation.outputDirectory'), workspaceDir ?? null, rootFile);
  const miktex = await detectMikTeX();

  const resolved = await resolveBuildRequest({
    rootFile,
    languageId: 'latex',
    recipeName: recipeName ?? undefined,
    jobId: `resolve-${Date.now()}`,
    settings: (scope?: string) => lwSettingsProvider(scope, options),
    fs: lwFileProvider,
    tmpDir: '',
    workspaceDir,
    outputDir,
    isMikTeX: () => miktex
  });

  if (!resolved) {
    return {
      request: null,
      recipeName: recipeName ?? 'default',
      error: 'No recipe could be resolved for this document.',
      warnings: []
    };
  }

  /*
   * The reference logs a name it could not resolve and then builds the first
   * recipe it has; Eukolia does the same and says so.
   *
   * `resolved.error` is therefore *not* fatal — a fallback recipe resolved and
   * can produce a PDF, and refusing to build because the name in a settings file
   * is stale would be a worse answer than building and reporting it. Only a plan
   * with nothing left to run is an error, and a recipe that names tools which do
   * not exist is reported the same way: the reference skips the undefined tool
   * and runs the rest.
   */
  const warnings = [...resolved.warnings];
  if (resolved.error) warnings.push(resolved.error);

  if (resolved.request.steps.length === 0) {
    const detail = warnings.length > 0 ? warnings.join(' ') : 'It expands to no executable tools.';
    return {
      request: null,
      recipeName: resolved.recipe.name,
      error: `The recipe "${resolved.recipe.name}" has no runnable steps. ${detail}`,
      warnings
    };
  }

  return { request: resolved.request, recipeName: resolved.recipe.name, warnings };
}

/**
 * The recipe name the ported resolver should fall back to: the recipe the user
 * chose, or the one their engine means.
 *
 * `compilation.recipe = "default"` is what makes `compilation.engine` a setting
 * that does something — before this the engine was read by nothing but the
 * status bar, so choosing XeLaTeX changed no command line anywhere.
 */
export function recipeNameFor(recipe: string, engine: string): string {
  const name = recipe.trim();
  if (name && name !== 'default') return name;
  return recipeForEngine(engine.trim()) ?? 'latexmk';
}

/**
 * Whether the installed TeX distribution is MiKTeX.
 *
 * `Plan.configureMaxPrintLine` of the reference shells out to
 * `pdflatex --version` and looks for the name; Eukolia already detects every
 * tool and keeps its first version line, so the answer is read from there and
 * costs no extra process.
 */
async function detectMikTeX(): Promise<boolean> {
  try {
    const tools = await buildService.detectTools();
    const pdflatex = tools.find((tool) => tool.name === 'pdflatex' || tool.name === 'latexmk');
    return /miktex/i.test(pdflatex?.version ?? '');
  } catch {
    return false;
  }
}

/** Filesystem access for the ported recipe resolver. */
const lwFileProvider: FileProvider = {
  async exists(filePath) {
    return (await window.eukoliaApi.stat(filePath)).exists;
  },
  async readFile(filePath) {
    try {
      return await window.eukoliaApi.readFile(filePath);
    } catch {
      return undefined;
    }
  },
  async readDirectory(dirPath) {
    const listing = await window.eukoliaApi.listDirectoryNames(dirPath);
    return [...listing.directories, ...listing.files];
  },
  async findFiles() {
    // The recipe resolver only needs this for project-wide root search, which
    // Eukolia performs with its own project index.
    return projectIndex.findTexFiles().map((file) => file.path);
  }
};

/**
 * Settings in the flat, dotted shape the ported LaTeX Workshop modules read.
 * Eukolia settings map onto the reference keys through the schema's `vscodeKey`
 * where one exists, and through explicit aliases below where they do not.
 *
 * **The two recipe keys are Eukolia's catalogue, not the reference's defaults.**
 * `latex.recipes` and `latex.tools` are what the plan builder resolves a recipe
 * name against and what resolves a tool name into a command line, and the
 * reference's default list contains tools Eukolia neither detects nor supports
 * (`Rscript`, `julia`, `pweave`). Writing the catalogue here — through
 * `recipeCatalog.ts`, adjusted for `compilation.synctex`, `extraArgs` and the
 * per-build force flag — means the resolver and the picker read the same list
 * and a recipe the picker offers is one the resolver knows.
 *
 * A user's own `latex-workshop.latex.recipes` (or `latex.recipes`) from the
 * advanced settings file still wins: it is checked first, and only an absent
 * value falls through to the catalogue.
 */
export function lwSettingsProvider(scope?: string, options: { force?: boolean } = {}): LwSettings {
  const bridged: LwSettings = { ...settingsManager.getAll() };

  const userRecipes = settingsManager.getValue('latex.recipes') ?? settingsManager.getValue('latex-workshop.latex.recipes');
  const userTools = settingsManager.getValue('latex.tools') ?? settingsManager.getValue('latex-workshop.latex.tools');
  const engine = setting.str('compilation.engine') || 'latexmk';

  const outDir = setting.str('compilation.outputDirectory');
  Object.assign(bridged, {
    'latex.recipes': Array.isArray(userRecipes) && userRecipes.length > 0 ? userRecipes : recipeConfigs(),
    'latex.tools':
      Array.isArray(userTools) && userTools.length > 0
        ? userTools
        : toolsWithOptions({
            synctex: setting.bool('compilation.synctex'),
            forceLatexmk: options.force === true || setting.bool('compilation.latexmk.minimumRule'),
            extraArgs: setting.list('compilation.extraArgs')
          }),
    'latex-workshop.latex.outDir': outDir || '%DIR%',
    'latex-workshop.latex.outputDir': outDir || '%DIR%',
    // `compilation.recipe` names a recipe, or `default` selects the engine. An
    // engine no recipe answers to falls back to `latexmk` rather than producing
    // a name the resolver would reject — the failure the picker used to cause.
    'latex-workshop.latex.recipe.default': recipeNameFor(setting.str('compilation.recipe'), engine),
    'latex-workshop.latex.autoBuild.run': setting.str('compilation.autoBuild'),
    // The reference has one number here — the least time between two builds.
    // Eukolia's debounce is its own, and travels beside it under a name of its
    // own so ported code that reads the reference's key gets the reference's
    // meaning rather than the debounce by accident.
    'latex-workshop.latex.autoBuild.interval': setting.num('compilation.autoBuildMinIntervalMs'),
    'latex-workshop.latex.autoBuild.delay': setting.num('compilation.autoBuildDelayMs'),
    'latex-workshop.latex.autoBuild.onSave.files.ignore': setting.list('compilation.autoBuildIgnore'),
    'latex-workshop.latex.clean.fileTypes': setting.list('compilation.cleanExtensions'),
    'latex-workshop.latex.args': setting.list('compilation.extraArgs'),
    'latex-workshop.latex.autoClean.onBuild': setting.bool('compilation.cleanAfterFailedBuild'),
    'latex-workshop.latex.build.forceRecipeUsage': false,
    'latex-workshop.latex.build.enableMagicComments': true,
    'latex-workshop.latex.build.fromWorkspaceFolder': false,
    'latex-workshop.latex.build.clearLog.everyRecipeStep.enabled': false,
    'latex-workshop.latex.jobname': false,
    'latex-workshop.latex.search.rootFiles.include': ['**/*.tex'],
    'latex-workshop.latex.search.rootFiles.exclude': [],
    'latex-workshop.latex.rootFile.useSubFile': true,
    'latex-workshop.latex.rootFile.doNotPrompt': false,
    'latex-workshop.latex.rootFile.indicator': '\\documentclass[]{}',
    'latex-workshop.latex.verbatimEnvs': ['verbatim', 'lstlisting', 'minted'],
    'latex-workshop.latex.autoBuild.cleanAndRetry.enabled': false,
    'latex-workshop.latex.clean.command': 'latexmk',
    'latex-workshop.latex.clean.args': ['-c', '%TEX%'],
    'latex-workshop.latex.clean.subfolder.enabled': false,
    'latex-workshop.latex.clean.fullSubfolder': false,
    'latex-workshop.latex.clean.method': 'glob',
    'latex-workshop.latex.synctex': setting.bool('compilation.synctex'),
    'latex-workshop.latex.autoBuild.recipe': 'default',
    'latex-workshop.latex.forceRecipe': '',

    'latex-workshop.intellisense.completion': setting.bool('latex.completion.enabled'),
    'latex-workshop.intellisense.package.enabled': setting.bool('latex.completion.packages'),
    'latex-workshop.intellisense.unimathsymbols.enabled': setting.bool('latex.completion.unicodeMath'),
    'latex-workshop.intellisense.citation.type': 'bibtex',
    'latex-workshop.intellisense.citation.label': 'title',
    'latex-workshop.intellisense.citation.maxfilesizeMB': 5,
    'latex-workshop.intellisense.command.user': {},
    'latex-workshop.intellisense.atSuggestion.user': {},
    'latex-workshop.intellisense.atSuggestion.triggerSuggest': true,
    'latex-workshop.intellisense.include.rootFile': true,

    'latex-workshop.linting.chktex.enabled': false,
    'latex-workshop.linting.lacheck.enabled': false,
    'latex-workshop.message.error.show': false,
    'latex-workshop.message.warning.show': false,
    'latex-workshop.message.badbox.show': 'off',
    'latex-workshop.message.log.show': false,
    'latex-workshop.message.bibtexlog.show': false,
    'latex-workshop.message.latexlog.exclude': [],
    'latex-workshop.log.level': setting.str('advanced.logLevel')
  });

  return bridged;
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

async function wireSnippets(): Promise<void> {
  const engine = getSnippetEngine();

  engine.setWarningSink((message) => {
    console.warn(`[snippets] ${message}`);
    void window.eukoliaApi.log('warn', `[snippets] ${message}`);
  });

  engine.setWorkspaceUriProvider(() => projectIndex.getProjectRoot() ?? '');

  // `snippets.allowJavaScript` off has to mean the code blocks do not run; the
  // engine asks this per expansion, so the switch is live.
  engine.setScriptingAllowedProvider(() => setting.bool('snippets.allowJavaScript'));

  // How many previous lines a multi-line trigger is read against. The ported
  // matcher reads this through the shim's `hsnips.multiLineContext`, and nothing
  // bridges that key, so the setting has to be handed over directly — and again
  // whenever it changes, since the matcher asks for it at each multi-line match.
  setMultiLineContext(setting.num('snippets.multiLineContext'));
  settingsManager.on('change', () => setMultiLineContext(setting.num('snippets.multiLineContext')));

  // Feed the Snippets panel's trigger history. This is attached to the engine
  // rather than to an editor because `SnippetEngine.expand` is the one place an
  // expansion is built — an `A`-flag snippet firing by itself and a completion
  // being accepted both arrive there, in Code Mode and Visual Mode alike — so one
  // hook covers every way a snippet can fire instead of one per call site.
  engine.setExpansionListener((candidate, expansion) => {
    const active = workspaceService.getActiveDocument();
    rememberExpansion(candidate.snippet, expansion.plainText, {
      documentUri: active?.uri ?? null
    });
  });

  engine.setVariableResolver((_names, defaults) => {
    const active = workspaceService.getActiveDocument();
    const now = new Date();
    return {
      ...defaults,
      // The base values as well as the VS Code spellings: the engine carries a
      // resolver's answers straight into a body's `${NAME}` tokens, and the names
      // the reference handed a resolver were these. They describe the document
      // being written into, which is the only thing that knows them.
      fileName: active?.filename ?? '',
      fileUri: active?.uri ?? '',
      dirName: active?.uri.replace(/[\\/][^\\/]*$/, '') ?? '',
      workspaceUri: projectIndex.getProjectRoot() ?? '',
      TM_FILENAME: active?.filename ?? '',
      TM_FILENAME_BASE: (active?.filename ?? '').replace(/\.[^.]*$/, ''),
      TM_DIRECTORY: active?.uri.replace(/[\\/][^\\/]*$/, '') ?? '',
      TM_FILEPATH: active?.uri ?? '',
      CURRENT_YEAR: String(now.getFullYear()),
      CURRENT_MONTH: String(now.getMonth() + 1).padStart(2, '0'),
      CURRENT_DATE: String(now.getDate()).padStart(2, '0'),
      CURRENT_DAY_NAME: now.toLocaleDateString('en-US', { weekday: 'long' })
    };
  });

  // One managed library, `<library>/.eukolia/snippets.json`, seeded on first run from
  // the built-in set. The store is what loads the engine, so the settings editor
  // and what actually expands in the editor cannot disagree.
  const store = getSnippetStore();
  await store.start();
  startupMark('bootstrap:snippets-loaded');

  const state = store.getSnapshot();
  if (state.readError || state.parseError) {
    console.warn('[eukolia] snippet library:', state.readError ?? state.parseError);
  }
  void window.eukoliaApi.log(
    'info',
    `[snippets] loaded ${store.snippets.length} snippet(s) from ${state.path || 'the built-in library'}`
  );
}

/** Reloads the snippet library from disk after the workspace changes. */
export async function reloadSnippets(): Promise<void> {
  await servicesReady();
  const store = getSnippetStore();
  await store.reload();
  store.refreshEngine();
}

/** Re-parses a compiler log with the ported parser. */
export function parseCompilerLog(log: string, rootFile: string | null) {
  return parseLatexLogFull(log, { rootFile: rootFile ?? undefined });
}
