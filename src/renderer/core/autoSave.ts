/**
 * `files.autoSave` — the four modes, and the events each one answers to.
 *
 * Instructions.md §45 asks for autosave, a configurable delay and "save on focus
 * change where desired". VS Code spells that out as a single enum with four
 * values, and this module is that vocabulary: the list the settings schema
 * offers, the sentence that explains each mode in the settings UI, and the table
 * that says which event a mode acts on.
 *
 * It is deliberately free of both the workspace and the DOM. The policy is a
 * pure function of (mode, trigger), so "does an editor losing focus save my
 * file?" is answered in one place that tests can read, instead of being spread
 * across the service and the shell as string comparisons that have to agree.
 */

/**
 * The four `files.autoSave` modes, in VS Code's order.
 *
 * `off` leaves every write to the user; `afterDelay` is the only mode that owns
 * a timer; the other two are trigger modes, and the *difference between them* is
 * what the trigger table below encodes.
 */
export const AUTO_SAVE_MODES = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'] as const;

export type AutoSaveMode = (typeof AUTO_SAVE_MODES)[number];

export const DEFAULT_AUTO_SAVE_MODE: AutoSaveMode = 'off';

/**
 * One sentence per mode, in the same order, shown beside the setting.
 *
 * The wording is VS Code's own (`files.autoSave`'s `markdownEnumDescriptions`),
 * so a choice made here means what the same choice means there — which matters
 * most for the pair that users confuse: `onFocusChange` also saves when the
 * *window* loses focus (see the table), but it additionally saves when focus
 * merely moves to another part of the window, and `onWindowChange` does not.
 */
export const AUTO_SAVE_MODE_DESCRIPTIONS = [
  'An editor with changes is never automatically saved.',
  'An editor with changes is automatically saved after the configured auto save delay.',
  'An editor with changes is automatically saved when the editor loses focus.',
  'An editor with changes is automatically saved when the window loses focus.'
] as const;

/**
 * What happened, from autosave's point of view.
 *
 * `afterDelay` is the timer the workspace arms when a document changes. The
 * other three are events the shell and the workspace report:
 *
 *  * `editorFocusLost` — the editor surface lost focus, whether to another part
 *    of the window (the file tree, the terminal) or to another application;
 *  * `windowFocusLost` — the whole window lost focus;
 *  * `activeEditorChange` — another document became active, which is VS Code's
 *    `onDidActiveEditorChange`: leaving an editor for another one is a focus
 *    change for the editor left behind.
 */
export type AutoSaveTrigger = 'afterDelay' | 'editorFocusLost' | 'windowFocusLost' | 'activeEditorChange';

/** Reads a stored value, treating anything unrecognised as `off`. */
export function normalizeAutoSaveMode(raw: unknown): AutoSaveMode {
  return typeof raw === 'string' && (AUTO_SAVE_MODES as readonly string[]).includes(raw)
    ? (raw as AutoSaveMode)
    : DEFAULT_AUTO_SAVE_MODE;
}

/**
 * Whether `mode` acts on `trigger`.
 *
 * The one entry worth reading twice is `windowFocusLost`: it saves under
 * `onFocusChange` as well as under `onWindowChange`. Losing the window's focus
 * is *a way* for the editor to lose focus, so a mode that promises to save
 * whenever the editor loses focus has to honour it — and VS Code's table says
 * the same thing in the same place (`reason === WINDOW_CHANGE && (mode ===
 * ON_FOCUS_CHANGE || mode === ON_WINDOW_CHANGE)` in `editorAutoSave.ts`).
 */
export function autoSaveRunsFor(mode: AutoSaveMode, trigger: AutoSaveTrigger): boolean {
  switch (trigger) {
    case 'afterDelay':
      return mode === 'afterDelay';
    case 'editorFocusLost':
    case 'activeEditorChange':
      return mode === 'onFocusChange';
    case 'windowFocusLost':
      return mode === 'onFocusChange' || mode === 'onWindowChange';
  }
}

/**
 * Which buffers a trigger saves.
 *
 * `focused` is the buffer that was being edited — the one VS Code saves on a
 * focus change. `all` is every dirty buffer, which is what a window losing focus
 * saves (VS Code's `saveAllDirtyAutoSaveables`): the window is going away, so
 * which editor happened to hold focus no longer describes what the user was
 * working on.
 */
export function autoSaveScopeFor(trigger: AutoSaveTrigger): 'focused' | 'all' {
  return trigger === 'windowFocusLost' ? 'all' : 'focused';
}
