/**
 * Eukolia command system.
 *
 * Every significant action is a command, so UI buttons, menu items, keybindings
 * and the palette all invoke the same implementation (Instructions.md §46, §48).
 * Commands can declare a `when` predicate, which lets the same shortcut mean
 * different things in Code Mode and Visual Mode.
 */

import { EventEmitter } from './events';

/** Context keys a command's `when` clause may inspect. */
/**
 * The command catalogue, as `IPC.commands` carries it between windows.
 *
 * Deliberately not `Command`: that type carries a `handler`, and a handler is a
 * closure over the shell's state which cannot cross a process boundary and must
 * not be able to. Four facts are what the shortcut editor draws a row from.
 *
 * Declared here rather than imported from `shared/ipc` so that `core/` stays
 * free of the platform contract — the two shapes are structurally identical and
 * the window that sends one satisfies the other.
 */
export interface CommandCatalogEntry {
  id: string;
  title: string;
  category: string;
  binding?: string;
  hidden?: boolean;
}

/** The catalogue for a set of commands, in the order the registry holds them. */
export function commandCatalog(commands: readonly Command[]): CommandCatalogEntry[] {
  return commands.map((command) => ({
    id: command.id,
    title: command.title,
    category: command.category,
    binding: command.keybinding,
    hidden: command.hidden
  }));
}

export interface CommandContext {
  editorMode: 'code' | 'visual';
  hasDocument: boolean;
  hasWorkspace: boolean;
  hasPdf: boolean;
  editorFocus: boolean;
  isBuilding: boolean;
  layout: string;
  /** Anything else a command wants to publish, e.g. `hasSelection`. */
  [key: string]: unknown;
}

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Display accelerator, e.g. `Ctrl+Shift+P`. */
  keybinding?: string;
  /** Additional accelerators. */
  secondaryKeybindings?: string[];
  /** Optional condition; when it returns false the command is hidden/inactive. */
  when?: (context: CommandContext) => boolean;
  /** Extra terms for palette search. */
  keywords?: string[];
  handler: (...args: unknown[]) => void | Promise<void>;
  /** Hidden from the palette but still invocable. */
  hidden?: boolean;
}

export interface ParsedKeybinding {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
};

/** Every spelling of a key name that has more than one. */
const KEY_NAME_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  return: 'enter',
  ' ': 'space',
  spacebar: 'space',
  plus: '+',
  minus: '-',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pageup: 'pageup',
  pagedown: 'pagedown'
};

/** Normalises a key name so `Esc`/`Escape`, `Del`/`Delete` and `Up`/`ArrowUp` match. */
function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase();
  return KEY_NAME_ALIASES[lower] ?? lower;
}

/**
 * The key name `event.code` names, or `''` for a key with no such spelling.
 *
 * `code` is the *physical* key: `KeyM` is the key beside `N` whatever the layout
 * prints on it. That is exactly what a binding needs when the layout — or a
 * modifier — has changed what `key` reads as, and it is what makes the fallback
 * in `matchesKeybinding` work for letters and digits under any shift state.
 */
function codeKeyName(code: string): string {
  const match = /^Key([A-Z])$/.exec(code);
  if (match) return match[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return numpad[1];
  return '';
}

export function parseKeybinding(binding: string): ParsedKeybinding | null {
  const parts = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const parsed: ParsedKeybinding = { ctrl: false, shift: false, alt: false, meta: false, key: '' };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier && i < parts.length - 1) {
      parsed[modifier] = true;
      continue;
    }
    parsed.key = normalizeKeyName(part);
  }

  return parsed.key ? parsed : null;
}

/** Renders a binding for display. `mod` becomes ⌘ on macOS and Ctrl elsewhere. */
export function formatKeybinding(binding: string, platform = detectPlatform()): string {
  const isMac = platform === 'darwin';
  return binding
    .split('+')
    .map((part) => {
      const trimmed = part.trim();
      const lower = trimmed.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') return isMac ? '⌃' : 'Ctrl';
      if (lower === 'cmd' || lower === 'command' || lower === 'meta') return isMac ? '⌘' : 'Win';
      if (lower === 'alt' || lower === 'option') return isMac ? '⌥' : 'Alt';
      if (lower === 'shift') return isMac ? '⇧' : 'Shift';
      if (lower === 'escape' || lower === 'esc') return 'Esc';
      if (lower === 'arrowup') return '↑';
      if (lower === 'arrowdown') return '↓';
      if (lower === 'arrowleft') return '←';
      if (lower === 'arrowright') return '→';
      if (trimmed.length === 1) return trimmed.toUpperCase();
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    })
    .join(isMac ? '' : '+');
}

function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'win32';
  const ua = navigator.userAgent;
  if (ua.includes('Mac')) return 'darwin';
  if (ua.includes('Linux')) return 'linux';
  return 'win32';
}

/**
 * The key names inside a binding, as this platform writes them.
 *
 * A title that states a shortcut has to state the *current* one, on the platform
 * the user is on: a hard-coded `(Ctrl+Alt+V)` in a tooltip keeps claiming a key
 * after the command is rebound in Settings, and on macOS it names a key that is
 * not on the keyboard.
 *
 * The separators follow the platform rather than the binding. `formatKeybinding`
 * joins macOS bindings with nothing and renders `⌃⌥V`, which is right for a
 * shortcut list and wrong at the end of a tooltip sentence — and Windows
 * bindings written as `Ctrl+B` keep their `+`. So the names are translated and
 * the platform's own convention decides what sits between them.
 */
export function translateKeybinding(binding: string, platform = detectPlatform()): string {
  const isMac = platform === 'darwin';
  const names: Record<string, string> = isMac
    ? { ctrl: '⌃', control: '⌃', cmd: '⌘', command: '⌘', meta: '⌘', super: '⌘', win: '⌘', alt: '⌥', option: '⌥', shift: '⇧' }
    : { cmd: 'Win', command: 'Win', meta: 'Win', super: 'Win', win: 'Win', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift' };

  return binding
    .split('+')
    .map((part) => {
      const trimmed = part.trim();
      const named = names[trimmed.toLowerCase()];
      if (named) return named;
      if (trimmed.length === 1) return trimmed.toUpperCase();
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    })
    .join(isMac ? '' : '+');
}

/** True when a keyboard event matches a parsed binding. */
export function matchesKeybinding(event: KeyboardEvent, parsed: ParsedKeybinding): boolean {
  const isMac = detectPlatform() === 'darwin';
  // On macOS the convention is Cmd where Windows uses Ctrl; accept both so a
  // binding written as `Ctrl+S` works on either platform.
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const primaryExpected = isMac ? parsed.meta || parsed.ctrl : parsed.ctrl;
  const secondaryUnexpected = isMac ? event.ctrlKey && !parsed.ctrl : event.metaKey && !parsed.meta;

  if (primaryExpected !== primary) return false;
  if (secondaryUnexpected) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;

  const eventKey = normalizeKeyName(event.key);
  if (eventKey === parsed.key) return true;

  /*
   * Fall back to the physical key, so a binding survives the layout *and* the
   * modifiers.
   *
   * `code` names the key that was physically pressed — `KeyM` is the key beside
   * `N` whatever the layout prints on it, and `Digit1` is the `1` whether the
   * keypad or the number row produced it. `event.key`, by contrast, is the
   * *composed* character: a layout can rewrite it, and a modifier can too. This
   * fallback already existed for letters; `codeKeyName` extends it to digits and
   * the keypad, which is the gap the tab bar's toolbar probe went looking for.
   */
  const fromCode = codeKeyName(event.code ?? '');
  if (fromCode && fromCode === parsed.key) return true;

  // `PageDown`, `Escape` and the rest of the spelled-out keys, whose `code` is
  // the same name: `code === 'PageDown'` and `parsed.key === 'pagedown'`.
  const code = (event.code ?? '').toLowerCase();
  if (parsed.key.length > 1 && code === parsed.key) return true;
  return false;
}

export interface CommandExecutionRecord {
  id: string;
  at: number;
}

export class CommandRegistry extends EventEmitter {
  private readonly commands = new Map<string, Command>();
  private readonly keybindings = new Map<string, string[]>();
  private readonly recent: CommandExecutionRecord[] = [];
  private readonly userOverrides = new Map<string, string>();
  /** Reads a command's binding from settings; installed by the application. */
  private settingsResolver: ((commandId: string) => string | undefined) | null = null;
  private context: CommandContext = {
    editorMode: 'code',
    hasDocument: false,
    hasWorkspace: false,
    hasPdf: false,
    editorFocus: true,
    isBuilding: false,
    layout: 'split'
  };

  public register(command: Command): () => void {
    if (this.commands.has(command.id)) {
      console.warn(`[eukolia] command "${command.id}" was registered twice; the newest handler wins`);
    }
    this.commands.set(command.id, command);
    this.reindexKeybindings();
    this.emit('registered', command);
    return () => this.unregister(command.id);
  }

  public registerAll(commands: readonly Command[]): () => void {
    const disposers = commands.map((command) => this.register(command));
    return () => disposers.forEach((dispose) => dispose());
  }

  public unregister(id: string): void {
    if (this.commands.delete(id)) {
      this.reindexKeybindings();
      this.emit('unregistered', id);
    }
  }

  public get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  public getAll(): Command[] {
    return [...this.commands.values()];
  }

  /** Commands whose `when` clause currently passes. */
  public getAvailable(): Command[] {
    return this.getAll().filter((command) => !command.when || command.when(this.context));
  }

  public isEnabled(id: string): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    return !command.when || command.when(this.context);
  }

  public async execute(id: string, ...args: unknown[]): Promise<void> {
    const command = this.commands.get(id);
    if (!command) {
      console.warn(`[eukolia] command "${id}" is not registered`);
      return;
    }
    if (command.when && !command.when(this.context)) {
      console.warn(`[eukolia] command "${id}" is not applicable in the current context`);
      return;
    }

    this.recordUsage(id);
    try {
      await command.handler(...args);
    } catch (err) {
      console.error(`[eukolia] command "${id}" failed`, err);
      this.emit('error', { id, error: err });
    }
  }

  /** Invokes a command even when its `when` clause fails; used by menus and tests. */
  public async executeUnconditionally(id: string, ...args: unknown[]): Promise<void> {
    const command = this.commands.get(id);
    if (!command) return;
    this.recordUsage(id);
    await command.handler(...args);
  }

  // ------------------------------------------------------------------ context

  public setContext(patch: Partial<CommandContext>): void {
    this.context = { ...this.context, ...patch };
    this.emit('context', this.context);
  }

  public getContext(): CommandContext {
    return this.context;
  }

  // -------------------------------------------------------------- keybindings

  /** Overrides a binding for one command (Instructions.md §48). */
  public setKeybinding(commandId: string, binding: string | null): void {
    if (binding === null) this.userOverrides.delete(commandId);
    else this.userOverrides.set(commandId, binding);
    this.reindexKeybindings();
    this.emit('keybindings-changed');
  }

  public getUserOverrides(): Record<string, string> {
    return Object.fromEntries(this.userOverrides);
  }

  public getKeybinding(commandId: string): string | undefined {
    return (
      this.settingsBinding(commandId) ??
      this.userOverrides.get(commandId) ??
      this.commands.get(commandId)?.keybinding
    );
  }

  /**
   * The binding the settings hold for a command, or `undefined`.
   *
   * Settings win over the registered default, so a shortcut changed in the
   * Settings UI (or in the advanced-settings JSON) takes effect immediately.
   * An empty string means "unbound" and is honoured as such, which is how a user
   * turns a default shortcut off without a special value.
   */
  private settingsBinding(commandId: string): string | undefined {
    if (!this.settingsResolver) return undefined;
    const value = this.settingsResolver(commandId);
    if (value === undefined) return undefined;
    return value.trim().length === 0 ? '' : value;
  }

  /**
   * Installs the lookup that reads bindings from settings and refreshes the
   * index. Called by the app once the settings manager is available.
   */
  public setSettingsResolver(
    resolver: ((commandId: string) => string | undefined) | null
  ): void {
    this.settingsResolver = resolver;
    this.reindexKeybindings();
    this.emit('keybindings-changed');
  }

  /** Re-reads every binding; called when the settings change. */
  public refreshKeybindings(): void {
    this.reindexKeybindings();
    this.emit('keybindings-changed');
  }

  private reindexKeybindings(): void {
    this.keybindings.clear();
    for (const command of this.commands.values()) {
      // A settings binding replaces the default outright; `userOverrides` is the
      // in-memory override used by the shortcuts editor before it is saved.
      const fromSettings = this.settingsBinding(command.id);
      const bindings = [
        ...(fromSettings === undefined ? [] : fromSettings ? [fromSettings] : []),
        ...(fromSettings !== undefined
          ? []
          : this.userOverrides.has(command.id)
            ? [this.userOverrides.get(command.id)!]
            : command.keybinding
              ? [command.keybinding]
              : []),
        // Secondary bindings stay available unless a settings binding replaced
        // the primary one, which is a deliberate rebind rather than an addition.
        ...(fromSettings === undefined ? command.secondaryKeybindings ?? [] : [])
      ];
      for (const binding of bindings) {
        if (!binding) continue;
        const list = this.keybindings.get(binding) ?? [];
        list.push(command.id);
        this.keybindings.set(binding, list);
      }
    }
  }

  /**
   * Resolves a keyboard event to a command id.
   * User overrides win; otherwise the first matching command whose `when` passes.
   */
  public resolveKeybinding(event: KeyboardEvent): string | null {
    for (const [binding, commandIds] of this.keybindings) {
      const parsed = parseKeybinding(binding);
      if (!parsed || !matchesKeybinding(event, parsed)) continue;
      const winner = this.firstApplicable(commandIds);
      if (winner) return winner;
    }
    return null;
  }

  /**
   * The command that actually answers to a binding, or `null`.
   *
   * Two commands can be registered on one key — the registry keeps a list per
   * binding and `resolveKeybinding` takes the first command whose `when` clause
   * passes — and the *loser* is then unreachable from the keyboard while still
   * reporting the binding it does not answer to. This is how a surface can say
   * whether the shortcut it shows is really its own: a tooltip that names a key
   * somebody else owns is worse than one that names none.
   */
  public getBindingOwner(binding: string): string | null {
    const commandIds = this.keybindings.get(binding);
    if (!commandIds) return null;
    return this.firstApplicable(commandIds);
  }

  /** The first command in a binding's list whose `when` clause currently passes. */
  private firstApplicable(commandIds: readonly string[]): string | null {
    for (const id of commandIds) {
      if (this.isEnabled(id)) return id;
    }
    return null;
  }

  public getAllKeybindings(): Array<{ commandId: string; title: string; category: string; binding: string }> {
    const rows: Array<{ commandId: string; title: string; category: string; binding: string }> = [];
    for (const [binding, commandIds] of this.keybindings) {
      for (const id of commandIds) {
        const command = this.commands.get(id);
        if (!command) continue;
        rows.push({ commandId: id, title: command.title, category: command.category, binding });
      }
    }
    return rows.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }

  // ------------------------------------------------------------------ palette

  public recordUsage(id: string): void {
    this.recent.unshift({ id, at: Date.now() });
    if (this.recent.length > 60) this.recent.pop();
    this.emit('used', id);
  }

  public getRecentlyUsed(limit = 10): Command[] {
    const seen = new Set<string>();
    const result: Command[] = [];
    for (const record of this.recent) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      const command = this.commands.get(record.id);
      if (command && !command.hidden && this.isEnabled(command.id)) result.push(command);
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Fuzzy subsequence match with a preference for prefix and word-boundary hits,
   * which is what makes a palette feel fast on a long command list.
   */
  public search(query: string): Command[] {
    const available = this.getAvailable().filter((command) => !command.hidden);
    const trimmed = query.trim();
    if (!trimmed) {
      const recent = this.getRecentlyUsed();
      const recentIds = new Set(recent.map((c) => c.id));
      return [...recent, ...available.filter((c) => !recentIds.has(c.id))];
    }

    const needle = trimmed.toLowerCase();
    const scored: Array<{ command: Command; score: number }> = [];
    for (const command of available) {
      const haystack = `${command.category} ${command.title} ${command.keywords?.join(' ') ?? ''} ${command.id}`.toLowerCase();
      const substringIndex = haystack.indexOf(needle);
      if (substringIndex !== -1) {
        scored.push({ command, score: 1000 - substringIndex });
        continue;
      }
      const fuzzy = fuzzyScore(needle, haystack);
      if (fuzzy > 0) scored.push({ command, score: fuzzy });
    }

    return scored
      .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
      .map((entry) => entry.command);
  }
}

/** Returns a positive score when `needle` is a subsequence of `haystack`. */
function fuzzyScore(needle: string, haystack: string): number {
  let score = 0;
  let haystackIndex = 0;
  let streak = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, haystackIndex);
    if (found === -1) return 0;
    const isBoundary = found === 0 || /[\s:.\-/]/.test(haystack[found - 1]);
    if (isBoundary) score += 8;
    streak = found === haystackIndex ? streak + 1 : 0;
    score += 2 + streak;
    haystackIndex = found + 1;
  }
  return score;
}

export const commandRegistry = new CommandRegistry();
