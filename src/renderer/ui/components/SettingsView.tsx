/**
 * SettingsView — the full-pane settings editor (Instructions.md §56, §57).
 *
 * The editor is generated entirely from `SETTINGS_SCHEMA`: every row is a
 * `SettingDescriptor`, every control is chosen from `descriptor.type`, and every
 * write goes through `settingsManager.setValue` after `validateSettingValue`
 * accepts it. Nothing is hard-coded per setting, so a new schema entry appears
 * here automatically with the right control, validation and reset button.
 *
 * Settings do not live in React state, so the view keeps a local `version`
 * counter and re-renders whenever the manager reports a change. The same counter
 * covers keybinding edits, which mutate the command registry in place.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SETTING_CATEGORIES, SHORTCUTS_SECTION, settingsManager, validateSettingValue, type SettingDescriptor } from '../../core/settings';
import { commandRegistry } from '../../core/commands';
import { useOptionalAppState } from '../state';
import { ScrollArea } from './ScrollArea';
import { ChevronLeft, Keyboard, RotateCcw, Search, Zap } from './icons';
// The pane's own sheet — the rail, the rows, the controls and the shortcut
// table. It is imported here rather than from `main.tsx` because this surface is
// lazily loaded: a sheet the shell always pays for is a sheet that should not be
// carrying two settings windows, and the standalone settings window never mounts
// the shell at all. `SnippetManager` imports it too, for the same reason in the
// other direction — see the file's own header.
import '../SettingsSurfaces.css';

export interface SettingsViewProps {
  section?: string;
  onSectionChange?: (section: string) => void;
  onOpenSnippets?: () => void;
}

/**
 * The synthetic category holding the keybinding editor.
 *
 * Defined in `core/settings.ts` beside `SETTING_CATEGORIES` and re-exported here,
 * because the shell's Escape handler has to name it and must not import this
 * module to do so — the pane is lazy-loaded, and a string import would defeat
 * that.
 */
export { SHORTCUTS_SECTION };

export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type BindingCapture =
  | { kind: 'binding'; binding: string }
  | { kind: 'clear' }
  | { kind: 'cancel' }
  | { kind: 'ignore' };

const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Unidentified',
  'Process',
  'OS'
]);

/** Key names that `parseKeybinding` normalises, written the way it expects. */
const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Escape',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert'
};

/**
 * Turns a keydown into something the keybinding system understands.
 *
 * `parseKeybinding` splits on `+`, so a literal `+` key cannot be represented and
 * is reported as `ignore` rather than stored as a binding that would never match.
 */
export function captureBinding(event: KeyboardEventLike): BindingCapture {
  if (MODIFIER_KEYS.has(event.key)) return { kind: 'ignore' };
  if (event.key === 'Escape') return { kind: 'cancel' };
  if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return { kind: 'clear' };
  }
  if (event.key === '+') return { kind: 'ignore' };

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Meta');

  const key = KEY_NAMES[event.key] ?? event.key;
  if (!key) return { kind: 'ignore' };
  parts.push(key);
  return { kind: 'binding', binding: parts.join('+') };
}

/** Comma- or newline-separated list, as edited in an array setting's textarea. */
export function parseListValue(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Renders a list value back into the textarea. */
export function formatListValue(value: unknown): string {
  return Array.isArray(value) ? value.map((entry) => String(entry)).join('\n') : '';
}

interface ShortcutGroup {
  commandId: string;
  title: string;
  category: string;
  /** The binding that currently wins, or `''` when the command is unbound. */
  binding: string;
  /** Extra bindings the command declares; they are shown but not edited here. */
  secondary: string[];
}

/**
 * Builds one editable row per visible command.
 *
 * `commandRegistry.getAllKeybindings()` only lists commands that currently have a
 * binding, which would make an unbound command impossible to bind. The rows are
 * therefore enumerated from `getAll()` and the bindings come from
 * `getKeybinding()`/`getAllKeybindings()`, so every command is editable and the
 * effective binding is always the one shown.
 */
export function buildShortcutGroups(
  commands: ReadonlyArray<{ id: string; title: string; category: string; hidden?: boolean }>,
  declared: ReadonlyArray<{ commandId: string; binding: string }>,
  effective: (commandId: string) => string | undefined
): ShortcutGroup[] {
  const byCommand = new Map<string, string[]>();
  for (const row of declared) {
    const list = byCommand.get(row.commandId);
    if (list) list.push(row.binding);
    else byCommand.set(row.commandId, [row.binding]);
  }

  return commands
    .filter((command) => !command.hidden)
    .map((command) => {
      const binding = effective(command.id) ?? '';
      const all = byCommand.get(command.id) ?? [];
      return {
        commandId: command.id,
        title: command.title,
        category: command.category,
        binding,
        secondary: all.filter((candidate) => candidate !== binding)
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * A settings control's surface is `.eu-input` from the design system, so the
 * field styles that used to live here — the padding, the border, the input
 * background, the radius — are gone. What is left inline in this component is
 * only what a test reads back or what is computed per render; every other value
 * is a class in `../SettingsSurfaces.css`.
 */

const SettingRow: React.FC<{ descriptor: SettingDescriptor; onChanged(): void }> = ({ descriptor, onChanged }) => {
  const value = settingsManager.getValue(descriptor.key);
  const scope = settingsManager.getScope(descriptor.key);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => formatListValue(value));
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  /**
   * What the selected option of an `enum` means, if the schema says.
   *
   * VS Code prints exactly this under the dropdown, and for a setting like
   * `files.autoSave` it is the only thing that tells `onFocusChange` apart from
   * `onWindowChange`: the option names are the vocabulary, these sentences are
   * the meaning.
   */
  const optionHint =
    descriptor.type === 'enum'
      ? descriptor.optionDescriptions?.[(descriptor.options ?? []).indexOf(String(value))]
      : undefined;

  useEffect(() => {
    if (descriptor.key !== 'snippets.userSnippetsDirectory') return;
    window.eukoliaApi.getProjectLibrary?.().then(status => setLibraryRoot(status.root)).catch(() => undefined);
  }, [descriptor.key]);

  useEffect(() => {
    if (descriptor.type === 'array') setDraft(formatListValue(settingsManager.getValue(descriptor.key)));
  }, [descriptor.key, descriptor.type, scope]);

  const commit = useCallback(
    (next: unknown) => {
      const problem = validateSettingValue(descriptor.key, next);
      if (problem) {
        setError(problem);
        return;
      }
      try {
        settingsManager.setValue(descriptor.key, next);
        setError(null);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [descriptor.key, onChanged]
  );

  const control = () => {
    switch (descriptor.type) {
      case 'boolean':
        return (
          <input
            type="checkbox"
            checked={Boolean(value)}
            title={`${descriptor.key} — ${Boolean(value) ? 'on' : 'off'}`}
            aria-label={descriptor.label}
            onChange={(event) => commit(event.target.checked)}
          />
        );

      case 'enum': {
        // The per-option sentences are attached to the options themselves, so
        // hovering the closed dropdown names the mode that is selected, and the
        // row's hint below spells it out in full.
        const optionDescriptions = descriptor.optionDescriptions ?? [];
        return (
          <select
            value={String(value)}
            title={descriptor.key}
            aria-label={descriptor.label}
            aria-invalid={error ? true : undefined}
            onChange={(event) => commit(event.target.value)}
            className="eu-input eu-settings__select"
          >
            {(descriptor.options ?? []).map((option, index) => (
              <option key={option} value={option} title={optionDescriptions[index]}>
                {option}
              </option>
            ))}
          </select>
        );
      }

      case 'number':
        return (
          <input
            type="number"
            value={typeof value === 'number' ? value : Number(value)}
            min={descriptor.min}
            max={descriptor.max}
            step={descriptor.step ?? 1}
            title={descriptor.key}
            aria-label={descriptor.label}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              if (event.target.value === '' || Number.isNaN(parsed)) {
                setError('must be a number');
                return;
              }
              commit(parsed);
            }}
            className="eu-input eu-settings__number eu-tnum"
          />
        );

      case 'color':
        return (
          <span className="eu-settings__color">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(String(value)) ? String(value) : '#000000'}
              title={`${descriptor.key} — pick a colour`}
              aria-label={`${descriptor.label} colour picker`}
              onChange={(event) => commit(event.target.value)}
              className="eu-settings__swatch"
            />
            <input
              value={String(value)}
              title={`${descriptor.key} — hex colour`}
              aria-label={descriptor.label}
              aria-invalid={error ? true : undefined}
              onChange={(event) => commit(event.target.value)}
              className="eu-input eu-settings__hex"
            />
          </span>
        );

      case 'array':
        return (
          <textarea
            value={draft}
            rows={3}
            title={`${descriptor.key} — one entry per line, or comma separated`}
            aria-label={descriptor.label}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit(parseListValue(draft))}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                commit(parseListValue(draft));
              }
            }}
            className="eu-input eu-settings__list"
          />
        );

      default:
        if (descriptor.key === 'snippets.userSnippetsDirectory') {
          if (libraryRoot) return <span className="eu-settings__library">
            <span>Snippets and global scripts are stored in your project library.</span>
            <code className="eu-settings__library-path">{libraryRoot}/.eukolia</code>
            <button type="button" className="eu-btn eu-btn-quiet" onClick={() => { void window.eukoliaApi.openLibrarySettings().catch(reason => setError(String(reason))); }}>Open shared files</button>
          </span>;
          return (
            <span className="eu-settings__path">
              <input
                value={String(value ?? '')}
                placeholder="Default (.eukolia in your project library)"
                title={descriptor.key}
                aria-label={descriptor.label}
                aria-invalid={error ? true : undefined}
                spellCheck={false}
                onChange={(event) => commit(event.target.value)}
                className="eu-input eu-settings__text"
              />
              <button
                type="button"
                className="eu-btn eu-btn-secondary eu-settings__browse"
                onClick={async () => {
                  if (typeof window !== 'undefined' && window.eukoliaApi?.openFolderDialog) {
                    const dir = await window.eukoliaApi.openFolderDialog();
                    if (dir) commit(dir);
                  }
                }}
              >
                Browse…
              </button>
            </span>
          );
        }
        return (
          <input
            value={String(value ?? '')}
            title={descriptor.key}
            aria-label={descriptor.label}
            aria-invalid={error ? true : undefined}
            spellCheck={false}
            onChange={(event) => commit(event.target.value)}
            className="eu-input"
          />
        );
    }
  };

  return (
    <div className="eu-settings__row">
      <div className="eu-settings__row-main">
        <div className="eu-settings__label-row">
          <span className="eu-settings__label">{descriptor.label}</span>
          {scope !== 'default' && (
            <span className="eu-chip eu-settings__chip eu-settings__chip--scope" title={`Set at ${scope} scope`}>
              {scope}
            </span>
          )}
          {descriptor.requiresReload && (
            <span className="eu-chip eu-settings__chip eu-settings__chip--reload" title="Needs an editor reload to take full effect">
              reload
            </span>
          )}
          {/*
            The one badge that says something about a setting *not* saved yet: a
            project may override it. Without it there is nothing on screen that
            distinguishes the handful of settings a `.eukolia/settings.json` can
            carry from the hundreds it cannot, and "why did my project not pick up
            this value?" has no answer in the UI.
          */}
          {descriptor.projectScoped && (
            <span
              className="eu-chip eu-settings__chip eu-settings__chip--project"
              title="A project may override this in its own .eukolia/settings.json"
            >
              per project
            </span>
          )}
        </div>
        <div className="eu-settings__key eu-mono">{descriptor.key}</div>
        {descriptor.description && <div className="eu-settings__description">{descriptor.description}</div>}
        {optionHint && <div className="eu-settings__description eu-settings__option-hint">{optionHint}</div>}
        {error && <div className="eu-settings__error">{error}</div>}
      </div>

      <div className="eu-settings__control">
        {control()}
        <button
          type="button"
          title={scope === 'default' ? 'Already at its default value' : 'Reset this setting to its default'}
          aria-label={`Reset ${descriptor.label}`}
          disabled={scope === 'default'}
          onClick={() => {
            settingsManager.reset(descriptor.key);
            setError(null);
            onChanged();
          }}
          className="eu-icon-btn eu-settings__reset"
        >
          <RotateCcw size={12} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/**
 * The way back out of a synthetic settings section.
 *
 * The shortcuts editor and the snippet manager each replace the settings body, so
 * each needs a control that returns to the category list rather than leaving the
 * user with nothing but Escape. Rendered only when the host supplies somewhere to
 * go, so a section mounted on its own never shows a control that does nothing.
 */
const LeaveSection: React.FC<{ onLeave?: () => void }> = ({ onLeave }) => {
  if (!onLeave) return null;
  return (
    <button
      type="button"
      className="eu-btn eu-btn-quiet"
      title="Back to the settings categories. Escape does the same from anywhere in Settings."
      aria-label="Back to all settings"
      onClick={onLeave}
    >
      <ChevronLeft size={12} strokeWidth={2} /> All settings
    </button>
  );
};

const ShortcutEditor: React.FC<{ version: number; onChanged(): void; onLeave?: () => void }> = ({
  version,
  onChanged,
  onLeave
}) => {
  const [filter, setFilter] = useState('');
  const [recording, setRecording] = useState<string | null>(null);

  const groups = useMemo(() => {
    void version;
    return buildShortcutGroups(commandRegistry.getAll(), commandRegistry.getAllKeybindings(), (id) => commandRegistry.getKeybinding(id));
  }, [version]);
  const overrides = commandRegistry.getUserOverrides();

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((group) => `${group.category} ${group.title} ${group.binding} ${group.secondary.join(' ')}`.toLowerCase().includes(needle));
  }, [filter, groups]);

  const onRecordKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, commandId: string) => {
      event.preventDefault();
      event.stopPropagation();
      const capture = captureBinding(event.nativeEvent);
      if (capture.kind === 'ignore') return;
      if (capture.kind === 'cancel') {
        setRecording(null);
        return;
      }
      if (capture.kind === 'clear') commandRegistry.setKeybinding(commandId, null);
      else commandRegistry.setKeybinding(commandId, capture.binding);
      setRecording(null);
      onChanged();
    },
    [onChanged]
  );

  return (
    <div className="eu-settings__shortcuts">
      <div className="eu-settings__shortcut-toolbar eu-search">
        <LeaveSection onLeave={onLeave} />
        <Search size={13} strokeWidth={1.8} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder="Filter shortcuts"
          aria-label="Filter shortcuts"
          spellCheck={false}
          className="eu-input eu-settings__filter"
        />
        <span className="eu-settings__shortcut-hint">
          Click a binding, then press the new keys. Escape cancels · Backspace restores the command default.
        </span>
      </div>

      <ScrollArea className="eu-settings__shortcut-scroll">
        {filtered.map((group) => {
          const overridden = Object.prototype.hasOwnProperty.call(overrides, group.commandId);
          return (
            <div key={group.commandId} className="eu-settings__shortcut-row">
              <span className="eu-settings__shortcut-category eu-truncate">{group.category}</span>
              <span className="eu-settings__shortcut-title eu-truncate" title={group.commandId}>
                {group.title}
              </span>
              {group.secondary.map((binding) => (
                <code
                  key={binding}
                  className="eu-kbd eu-settings__binding eu-settings__binding--secondary"
                  title="Additional binding declared by the command; it is not editable here"
                >
                  {binding}
                </code>
              ))}
              {recording === group.commandId ? (
                <input
                  readOnly
                  autoFocus
                  value="Press keys…"
                  aria-label={`Recording a new binding for ${group.title}`}
                  onKeyDown={(event) => onRecordKeyDown(event, group.commandId)}
                  onBlur={() => setRecording(null)}
                  className="eu-input eu-settings__recording"
                />
              ) : (
                <button
                  type="button"
                  title={`Change the binding for ${group.title}`}
                  onClick={() => setRecording(group.commandId)}
                  className={`eu-kbd eu-settings__binding${group.binding ? '' : ' eu-settings__binding--unbound'}`}
                >
                  {group.binding || 'unbound'}
                </button>
              )}
              <button
                type="button"
                title={overridden ? 'Restore the default binding' : 'This binding is the command default'}
                aria-label={`Reset binding for ${group.title}`}
                disabled={!overridden}
                onClick={() => {
                  commandRegistry.setKeybinding(group.commandId, null);
                  onChanged();
                }}
                className="eu-icon-btn eu-settings__reset"
              >
                <RotateCcw size={12} strokeWidth={1.8} />
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="eu-empty">No shortcuts match.</div>}
      </ScrollArea>
    </div>
  );
};

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export const SettingsView: React.FC<SettingsViewProps> = ({
  section: propSection,
  onSectionChange,
  onOpenSnippets
}) => {
  const appState = useOptionalAppState();
  const [localSection, setLocalSection] = useState(propSection ?? SETTING_CATEGORIES[0]);

  useEffect(() => {
    if (propSection !== undefined) {
      setLocalSection(propSection);
    }
  }, [propSection]);

  const section = propSection ?? (appState ? appState.settingsSection : localSection);
  const openSettingsSection = onSectionChange ?? (appState ? appState.openSettingsSection : setLocalSection);
  const toggleSnippets = onOpenSnippets ?? (() => {
    if (window.eukoliaApi?.openSnippetsWindow) {
      void window.eukoliaApi.openSnippetsWindow();
    } else if (appState?.toggleSnippets) {
      appState.toggleSnippets();
    }
  });
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const bump = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const disposers = [
      settingsManager.on('change', bump),
      commandRegistry.on('registered', bump),
      commandRegistry.on('keybindings-changed', bump)
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [bump]);

  const groups = useMemo(() => {
    void version;
    const byCategory = new Map(settingsManager.byCategory().map((group) => [group.category as string, group.settings]));
    return SETTING_CATEGORIES.filter((category) => byCategory.has(category)).map((category) => ({
      category: category as string,
      settings: byCategory.get(category) ?? []
    }));
  }, [version]);

  /** The snippet settings, so the library section can link to them. */
  const snippetSettings = useMemo(
    () => groups.find((group) => group.category === 'Snippets')?.settings ?? [],
    [groups]
  );

  const searchResults = useMemo(() => {
    void version;
    const trimmed = query.trim();
    return trimmed ? settingsManager.search(trimmed) : [];
  }, [query, version]);

  const active = useMemo(() => groups.find((group) => group.category === section) ?? groups[0], [groups, section]);
  const searching = query.trim().length > 0;

  /**
   * Opens a section — and closes it when it is already the one showing.
   *
   * The synthetic sections replace the settings body rather than appearing beside
   * it, so clicking the entry that led there a second time has to be the way back.
   * A category in the list is a different thing: clicking the category you are
   * already reading is a no-op, exactly as it is in VS Code.
   */
  const enterSection = useCallback(
    (target: string) => {
      setQuery('');
      openSettingsSection(target);
    },
    [openSettingsSection]
  );

  /** Returns to the category list from a synthetic section. */
  const leaveSection = useCallback(() => {
    setQuery('');
    openSettingsSection(SETTING_CATEGORIES[0]);
  }, [openSettingsSection]);

  return (
    <div className="eu-settings">
      <div className="eu-settings__rail">
        <div className="eu-settings__rail-title">Settings</div>
        <ScrollArea className="eu-settings__rail-scroll">
          {groups.map((group) => {
            const isActive = !searching && active?.category === group.category;
            return (
              <button
                key={group.category}
                type="button"
                title={`${group.settings.length} settings`}
                aria-pressed={isActive}
                onClick={() => {
                  setQuery('');
                  openSettingsSection(group.category);
                }}
                className="eu-settings__category"
              >
                <span className="eu-settings__category-name">{group.category}</span>
                <span className="eu-badge eu-settings__category-count">{group.settings.length}</span>
              </button>
            );
          })}

          <button
            type="button"
            title={
              section === SHORTCUTS_SECTION
                ? 'Back to the settings categories'
                : 'Edit the keyboard binding of every command'
            }
            aria-pressed={section === SHORTCUTS_SECTION}
            onClick={() => enterSection(SHORTCUTS_SECTION)}
            className="eu-settings__category eu-settings__category--section"
          >
            <Keyboard size={12} strokeWidth={1.8} />
            <span className="eu-settings__category-name">{SHORTCUTS_SECTION}</span>
          </button>
        </ScrollArea>
      </div>

      <div className="eu-settings__body">
        <div className="eu-settings__toolbar eu-search">
          <Search size={13} strokeWidth={1.8} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') setQuery('');
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            title="Search every setting by name, key, description or keyword"
            spellCheck={false}
            className="eu-input eu-settings__search"
          />

          <span className="eu-settings__spacer" />

          {confirmResetAll ? (
            <>
              <span className="eu-settings__confirm">Reset every user setting?</span>
              <button
                type="button"
                title="Discard all user-level setting overrides"
                onClick={() => {
                  settingsManager.resetAll('user');
                  setConfirmResetAll(false);
                  bump();
                }}
                className="eu-btn eu-btn-quiet eu-settings__danger"
              >
                Confirm
              </button>
              <button type="button" title="Keep the current settings" onClick={() => setConfirmResetAll(false)} className="eu-btn eu-btn-quiet">
                Cancel
              </button>
            </>
          ) : (
            <button type="button" title="Reset every user-level setting to its default" onClick={() => setConfirmResetAll(true)} className="eu-btn eu-btn-quiet">
              Reset all
            </button>
          )}
        </div>

        <div className="eu-settings__content">
          {section === SHORTCUTS_SECTION && !searching ? (
            <ShortcutEditor version={version} onChanged={bump} onLeave={leaveSection} />
          ) : (
            <ScrollArea className="eu-settings__scroll">
              {searching && (
                <>
                  <div className="eu-settings__section-title">
                    {searchResults.length} setting{searchResults.length === 1 ? '' : 's'} matching “{query.trim()}”
                  </div>
                  {searchResults.map((descriptor) => (
                    <SettingRow key={descriptor.key} descriptor={descriptor} onChanged={bump} />
                  ))}
                  {searchResults.length === 0 && <div className="eu-empty">No setting matches that search.</div>}
                </>
              )}

              {!searching && active && (
                <>
                  <div className="eu-settings__section-title">{active.category}</div>
                  {active.category === 'Snippets' && (
                    <button
                      type="button"
                      className="eu-btn eu-btn-secondary eu-settings__action"
                      title="Open the snippet library (Ctrl+Alt+L)"
                      onClick={() => toggleSnippets()}
                    >
                      <Zap size={12} strokeWidth={1.8} /> Manage snippets…
                    </button>
                  )}
                  {active.settings.map((descriptor) => (
                    <SettingRow key={descriptor.key} descriptor={descriptor} onChanged={bump} />
                  ))}
                  {active.category === 'Snippets' && (
                    <div className="eu-settings__note">
                      {snippetSettings.length} settings configure the engine; the snippets themselves are edited in{' '}
                      <button type="button" className="eu-settings__link" onClick={() => toggleSnippets()}>
                        Manage snippets
                      </button>
                      , which opens in a window of its own.
                    </div>
                  )}
                </>
              )}

              {!searching && !active && <div className="eu-empty">No settings are defined.</div>}

              {!searching && (
                <div className="eu-settings__note">
                  Settings are stored for you and apply to every project (Default &lt; User &lt; Project, Instructions.md §57). The few marked
                  &ldquo;per project&rdquo; — the build, the root document, the snippet folders a project ships — can also be set in one
                  project&rsquo;s own <code className="eu-mono">.eukolia/settings.json</code>; everything else here is yours alone. The row marker shows
                  which scope currently wins; the reset button removes the override so the default applies again.
                </div>
              )}
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsView;
