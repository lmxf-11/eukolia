/**
 * Sidebar — the single side panel: project explorer, outline, project search,
 * symbols, problems and snippet history (Instructions.md §29, §40, §44, §49,
 * §51, §55).
 *
 * `useAppState().sidebarView` selects the view; everything else is read from app
 * state, so this component owns no application data. The only writes it performs
 * are the explorer's file operations (through `explorerActions`, which is backed
 * by the workspace service) and the snippet reload.
 *
 * The UI is deliberately dense: 20–22px rows and a 12px indent step, because a
 * file tree, a result list and a diagnostic list all want as many rows on screen
 * as they can get. What is *not* dense is the styling: every surface, radius,
 * colour, transition and hover in here comes from `ui/sidebar-panels.css`, which
 * is imported below, and from the design system it builds on. What is left
 * inline is exactly two things, and both are marked where they appear:
 *
 *  * **values `tests/ui/*` reads back off the element** — the Explorer row's
 *    `background` (the selected-file fill and the plain `transparent` of every
 *    other row), the PDF-active file's name colour and weight, the Outline row's
 *    `height` and `paddingLeft`, and the Outline title's `flex`/`min-width`/
 *    `text-overflow`. Each one carries a comment naming the test that asserts it;
 *    moving any of them into the stylesheet would delete the assertion's subject.
 *  * **values computed per render** — a tree row's indent from its depth, a
 *    context menu's position from the pointer, a dialog's position from where its
 *    row sits on screen, an inline editor's busy dim. A class cannot express any
 *    of them, and a style attribute that mixes one computed property with five
 *    static ones is the case that is genuinely easier to read as it stands.
 *
 * Everything else is a className, including state: a folder's open/closed tint
 * and a diagnostic's severity colour are published as `data-eu-*` values and
 * resolved in the stylesheet, which is the convention `eukolia-design.css`
 * established for state a component owns but does not colour.
 */

// The panels' own stylesheet. Imported here rather than from `main.tsx` so the
// rules ship with the markup they dress: a panel that stops rendering takes its
// CSS out of the bundle with it, and a reader opening this file is one line away
// from the styles it is wearing. Vite resolves this at build time and Vitest
// treats it as an inert side-effect import, so neither the renderer nor the jsdom
// tests need anything else.
import '../sidebar-panels.css';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FileNode } from '../../../shared/ipc';
import { useAppState } from '../state';
import type { SearchHit } from '../state';
import type { OutlineItem } from '../../document/analysisTypes';
import { projectIndex } from '../../document/projectIndex';
import { getSnippetEngine, type HSnippet } from '../../snippets/engine';
import { getSnippetStore } from '../../snippets/store';
import {
  snippetHistory,
  summariseExpansion,
  formatSince,
  formatClockTime,
  describeExpansion,
  type SnippetHistoryEntry
} from '../../snippets/history';
import { reloadSnippets } from '../../services/bootstrap';
import { setting, settingsManager } from '../../core/settings';
import { ScrollArea } from './ScrollArea';
import { createExplorerActions, validateExplorerName } from './explorerActions';
import type { ProjectLibraryStatus } from '../../../shared/projectLibrary';
import { commandRegistry, translateKeybinding, type Command } from '../../core/commands';
import { APP_MENUS, commandsForMenu } from '../appMenus';
import { showProjectLibrary } from './ProjectLibrary';
import { renderTabIcon } from './TabBar';
import {
  ArrowRight,
  Boxes,
  Braces,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleAlert,
  Eye,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Info,
  LayoutPanelLeft,
  Library,
  ListTree,
  Menu,
  Play,
  Quote,
  RefreshCw,
  Regex,
  ReplaceAll,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  SquareFunction,
  Tag,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  WholeWord,
  X,
  Zap,
  type LucideProps
} from './icons';

export interface SidebarProps {
  /** No props: the active view comes from app state. */
}

const TEXT_FILE = /\.(tex|ltx|bib|sty|cls|txt|md|markdown|log|json|yaml|yml|cfg|toml|tikz|def|dtx|ins|js|mjs|cjs|jsx|ts|tsx)$/i;
const BIB_FILE = /\.bib$/i;
const PDF_FILE = /\.pdf$/i;

/**
 * The extension of a file name, lower-cased and without the dot.
 *
 * A leading dot is not a separator: `.gitignore` is a dotfile whose "extension"
 * would otherwise read as `gitignore`, which is never what a file-type list
 * means. Such names have no extension and are filtered as such.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** True when the Explorer should list this file, given the configured types. */
export function matchesExplorerTypes(name: string, include: readonly string[]): boolean {
  // An empty list is read as "no restriction" rather than "show nothing": a user
  // who clears the setting wants their files back, not an empty tree.
  if (include.length === 0) return true;
  const extension = extensionOf(name);
  if (!extension) return false;
  return include.some((entry) => entry.trim().replace(/^\./, '').toLowerCase() === extension);
}

/**
 * Applies the Explorer's file-type filter to the project tree.
 *
 * Folders are never dropped — a folder whose visible contents are all filtered
 * away still appears, so the shape of the project is preserved and expanding one
 * is never a dead end that reads as a bug.
 *
 * `keep` is the escape hatch: the file open in the editor and the PDF in the
 * viewer are kept whatever the filter says. The Explorer is where both are
 * marked as active, and a view that highlights a row which is not there cannot
 * show you where you are — so a document opened another way (Quick Open, a
 * recent file, a `\input` jump) stays visible even when its type is excluded.
 */
export function filterExplorerNodes(
  nodes: readonly FileNode[],
  include: readonly string[],
  keep?: ReadonlySet<string>
): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.isDirectory) {
      // A fresh object rather than a mutation: the tree in app state is shared
      // with the project index, which needs every file for `\input` resolution
      // and root detection.
      result.push({
        ...node,
        children: node.children ? filterExplorerNodes(node.children, include, keep) : node.children
      });
      continue;
    }
    if (matchesExplorerTypes(node.name, include) || keep?.has(node.path)) result.push(node);
  }
  return result;
}

/** Directories that start out expanded: the first two levels of the tree. */
export function defaultExpandedPaths(nodes: readonly FileNode[], depth = 2): Set<string> {
  const paths = new Set<string>();
  const walk = (list: readonly FileNode[], level: number) => {
    if (level >= depth) return;
    for (const node of list) {
      if (!node.isDirectory) continue;
      paths.add(node.path);
      if (node.children && node.children.length > 0) walk(node.children, level + 1);
    }
  };
  walk(nodes, 0);
  return paths;
}

/** The trigger text of a snippet; regex triggers expose their source. */
export function snippetTrigger(snippet: HSnippet): string {
  return snippet.trigger || snippet.regexp?.source || '(regex)';
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * The row classes the tree's indentation guides are drawn from.
 *
 * Every row of the tree is an independent element, so a guide — the vertical
 * rule that shows which folder a row belongs to — has to be drawn per row. The
 * stylesheet draws it as a background image positioned at each 12px step, which
 * means one class per depth; past six the guides stop and the indent carries the
 * hierarchy on its own, because a chain of `\input`s can nest arbitrarily deep
 * and there is no such thing as a class per level.
 *
 * The *indent* is unaffected: it is inline (see `renderNodes`), because the depth
 * is what this component computes and a class would have to be built from it
 * anyway.
 */
function treeGuideClass(depth: number): string {
  return depth >= 2 && depth <= 6 ? ` eu-sidebar-tree__row--d${depth}` : '';
}

/** A compact, self-contained inline editor for new and renamed entries. */
const NameInput: React.FC<{
  initial?: string;
  placeholder: string;
  indent: number;
  icon?: React.ReactNode;
  validate?(value: string): string | null;
  onCommit(value: string): Promise<void> | void;
  onCancel(): void;
}> = ({ initial = '', placeholder, indent, icon, validate, onCommit, onCancel }) => {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = useCallback(async () => {
    const problem = validate ? validate(value) : null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await onCommit(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [onCommit, validate, value]);

  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  return (
    <div className="eu-sidebar-tree__editor" style={{ paddingLeft: indent }}>
      <div className="eu-sidebar-tree__editor-row">
        {icon}
        <input
          ref={inputRef}
          className="eu-input eu-sidebar-panel__field"
          value={value}
          spellCheck={false}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          onBlur={cancel}
          style={{
            // The field is a row of the tree, so its own 13px-plus-inset padding
            // is too tall for a 22px line. The only computed value is the busy
            // dim — a busy row is *dimmed* rather than disabled, because
            // disabling the input would blur it and cancel the very operation in
            // flight. The error border is a second state of the same control and
            // is published as `aria-invalid`, which the design system styles.
            padding: '1px 5px',
            opacity: busy ? 0.6 : undefined
          }}
          aria-invalid={error ? true : undefined}
        />
      </div>
      {error && <div className="eu-sidebar-tree__editor-error">{error}</div>}
    </div>
  );
};

/**
 * The header's action button — and the same control the snippet history and the
 * Search panel use, so it is `.eu-icon-btn` (the design system's quiet 22px
 * glyph) rather than a shape of its own. `title` and `aria-label` carry the same
 * string, so the button is named identically for the pointer and for a screen
 * reader.
 */
const IconButton: React.FC<{
  title: string;
  onClick(): void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, children }) => (
  <button
    type="button"
    className="eu-icon-btn eu-pressable eu-sidebar-icon-btn"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
);

/**
 * The header every view has, and the reason the panels read as one set.
 *
 * A title on the left — set as a micro-label with tracking, because seven
 * panels each shouting their name at 15px is seven headings competing with the
 * content under them — and a right-aligned cluster of quiet glyphs. A control
 * whose whole meaning is already in its `title` is an icon here and not a word:
 * "New File" and "Collapse all folders" are the same shape in every editor, and
 * spelling them out costs the panel a line of width it needs for file names.
 */
const ViewHeader: React.FC<{ title: string; children?: React.ReactNode }> = ({ title, children }) => (
  <div className="eu-sidebar-panel__header">
    <span className="eu-sidebar-panel__title eu-eyebrow eu-truncate">{title}</span>
    <span className="eu-sidebar-panel__actions">{children}</span>
  </div>
);

/**
 * A panel with nothing in it. `.eu-empty` is the design system's centred block;
 * this only narrows it, because a sidebar is 260px wide and the 32px of vertical
 * padding the shared class uses is a third of a short panel.
 */
const EmptyHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="eu-empty eu-sidebar-tree__empty">{children}</div>
);

/**
 * Severity glyph shared with the bottom panel, so the two lists cannot diverge.
 *
 * Each one carries a `data-eu-severity` state rather than a colour written
 * inline, so the semantic token lives in the stylesheet where the rest of the
 * palette does and a theme can adjust the mark without a second copy of this
 * function. The `data-eu-severity` value is also what a reader of the DOM can
 * filter on, which the class alone would not give them.
 */
export const severityIcon = (severity: 'error' | 'warning' | 'information') => {
  if (severity === 'error') {
    return <CircleAlert className="eu-sidebar-severity" data-eu-severity="error" size={13} strokeWidth={2} />;
  }
  if (severity === 'warning') {
    return <TriangleAlert className="eu-sidebar-severity" data-eu-severity="warning" size={13} strokeWidth={2} />;
  }
  return <Info className="eu-sidebar-severity" data-eu-severity="information" size={13} strokeWidth={2} />;
};

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

interface ContextMenuState {
  node: FileNode;
  x: number;
  y: number;
}

const ExplorerView: React.FC = () => {
  const { fileTree, workspace, activeDocument, pdf, openFile, openFolder, setStatusMessage, setPdfPath, setPdfVisible } = useAppState();
  const actions = useMemo(() => createExplorerActions(), []);

  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpandedPaths(fileTree));
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [createParent, setCreateParent] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const knownDirectories = useRef<Set<string>>(new Set());

  // `files.explorerInclude` is read through the settings manager rather than app
  // state, and mirrored into a revision counter so editing it takes effect at
  // once instead of on the next project or file event.
  const [settingsRevision, setSettingsRevision] = useState(0);
  useEffect(() => settingsManager.on('change', () => setSettingsRevision((value) => value + 1)), []);

  const includedTypes = useMemo(
    () => setting.list('files.explorerInclude'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the revision is the trigger
    [settingsRevision]
  );

  /**
   * The file open in the editor and the PDF in the viewer are always listed, so
   * the Explorer can show you where you are even for a type the filter hides.
   */
  const alwaysVisible = useMemo(() => {
    const paths = new Set<string>();
    if (activeDocument) paths.add(activeDocument.doc.uri);
    if (pdf.visible && pdf.path) paths.add(pdf.path);
    return paths;
  }, [activeDocument, pdf.visible, pdf.path]);

  // What the tree actually shows. Filtering happens here rather than in the main
  // process because `fileTree` is also the project index's file list — root
  // detection, `\input` resolution and bibliography parsing all walk it — so the
  // full tree has to survive; only its presentation is narrowed.
  const displayTree = useMemo(
    () => filterExplorerNodes(fileTree, includedTypes, alwaysVisible),
    [fileTree, includedTypes, alwaysVisible]
  );

  // Newly discovered directories near the top of the tree open by default; a
  // directory the user closed stays closed. This tracks the *displayed* tree, so
  // a folder the file-type filter leaves empty is not auto-expanded to reveal
  // nothing.
  useEffect(() => {
    const all = defaultExpandedPaths(displayTree, Number.POSITIVE_INFINITY);
    const nearTop = defaultExpandedPaths(displayTree, 2);
    setExpanded((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const path of nearTop) {
        if (!knownDirectories.current.has(path) && !next.has(path)) {
          next.add(path);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    knownDirectories.current = all;
  }, [displayTree]);

  useEffect(() => {
    if (!menu) return;
    setConfirmDelete(false);
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const startCreate = useCallback((kind: 'file' | 'folder', parent: string | null) => {
    setRenaming(null);
    setCreating(kind);
    setCreateParent(parent);
    if (parent) setExpanded((previous) => new Set(previous).add(parent));
  }, []);

  const openEntry = useCallback(
    (node: FileNode) => {
      if (node.excluded) {
        setStatusMessage(`${node.name} is excluded by the files.exclude setting`);
        return;
      }
      if (PDF_FILE.test(node.name)) {
        setPdfPath(node.path);
        setPdfVisible(true);
        return;
      }
      if (!TEXT_FILE.test(node.name)) {
        setStatusMessage(`${node.name} is not a text file; Eukolia cannot open it in the editor`);
        return;
      }
      void openFile(node.path);
    },
    [openFile, setPdfPath, setPdfVisible, setStatusMessage]
  );

  const renderCreateRow = (parent: string | null, depth: number) =>
    creating ? (
      <NameInput
        key={`create-${parent ?? 'root'}`}
        placeholder={creating === 'file' ? 'New file name (e.g. sections/intro.tex)' : 'New folder name'}
        indent={6 + depth * 12}
        icon={
          creating === 'file' ? (
            <FilePlus size={13} strokeWidth={1.8} />
          ) : (
            <FolderPlus size={13} strokeWidth={1.8} />
          )
        }
        validate={(value) => validateExplorerName(value, { allowPath: creating === 'file' })}
        onCommit={async (value) => {
          const created = creating === 'file' ? await actions.createFile(value, parent ?? undefined) : await actions.createFolder(value, parent ?? undefined);
          setCreating(null);
          setCreateParent(null);
          setStatusMessage(`Created ${created}`);
        }}
        onCancel={() => {
          setCreating(null);
          setCreateParent(null);
        }}
      />
    ) : null;

  const renderNodes = (nodes: readonly FileNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isOpen = expanded.has(node.path);
      const isActive = !node.isDirectory && activeDocument?.doc.uri === node.path;
      // The PDF the viewer is showing. This cannot be folded into `isActive`:
      // a PDF is never an open document — clicking one hands it to the viewer
      // rather than opening a buffer — so the document comparison above can
      // never be true for it, and the file the user is actually reading was
      // the one row in the tree that never lit up.
      const isActivePdf = !node.isDirectory && pdf.visible && pdf.path === node.path;
      const marked = isActive || isActivePdf;
      const indent = 6 + depth * 12;

      if (renaming === node.path) {
        return (
          <NameInput
            key={node.path}
            initial={node.name}
            placeholder="New name"
            indent={indent}
            icon={node.isDirectory ? <Folder size={13} strokeWidth={1.8} /> : renderTabIcon(node.name)}
            validate={(value) => validateExplorerName(value)}
            onCommit={async (value) => {
              const target = await actions.rename(node.path, value);
              setRenaming(null);
              setStatusMessage(`Renamed to ${target.replace(/^.*[\\/]/, '')}`);
            }}
            onCancel={() => setRenaming(null)}
          />
        );
      }

      /*
       * A folder's glyph says its state with colour: open is the accent, closed
       * is the ordinary secondary text. The mark travels with the element as a
       * `data-eu` state rather than as an inline declaration, which is the same
       * convention the design system uses for `data-eu-active` — so a theme can
       * reach the open folder without a second copy of this ternary.
       */
      const icon = node.isDirectory ? (
        <span className="eu-sidebar-tree__folder" data-eu-folder-open={isOpen ? 'true' : 'false'}>
          {isOpen ? <FolderOpen size={13} strokeWidth={1.8} /> : <Folder size={13} strokeWidth={1.8} />}
        </span>
      ) : (
        renderTabIcon(node.name)
      );

      const title = node.excluded
        ? `${node.path} — excluded by the files.exclude setting`
        : isActivePdf
          ? `${node.path} — shown in the PDF viewer`
          : isActive
            ? `${node.path} — open in the editor`
            : node.isDirectory
              ? `${node.path} — Enter to ${isOpen ? 'collapse' : 'expand'}`
              : `${node.path} — Enter to open`;

      return (
        <React.Fragment key={node.path}>
          <div
            className={[
              // `eu-sidebar-tree__row` is the pill, its hover surface and its
              // transition; the two modifiers are per-render state, and the
              // guide class is derived from this row's depth so the vertical
              // rules land on the padding-left of the rows they group.
              'eu-sidebar-tree__row',
              treeGuideClass(depth),
              dragOverPath === node.path ? ' eu-sidebar-tree__row--drop' : '',
              // The shortcut lets Eukolia open a file the file-type filter
              // hides; the row says so by receding rather than by disappearing,
              // so the tree's shape stays honest about what is on disk.
              node.excluded ? ' eu-sidebar-tree__row--excluded' : ''
            ].join('')}
            role="treeitem"
            aria-expanded={node.isDirectory ? isOpen : undefined}
            aria-selected={marked}
            aria-current={isActivePdf ? 'true' : undefined}
            data-active={marked ? 'true' : undefined}
            data-active-kind={isActivePdf ? 'pdf' : isActive ? 'document' : undefined}
            tabIndex={0}
            title={title}
            draggable={!renaming}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/x-eukolia-path', node.path);
              event.dataTransfer.effectAllowed = 'copyMove';
            }}
            onDragOver={(event) => {
              if (node.isDirectory) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                if (dragOverPath !== node.path) setDragOverPath(node.path);
              }
            }}
            onDragLeave={(event) => {
              if (dragOverPath === node.path) {
                event.stopPropagation();
                setDragOverPath(null);
              }
            }}
            onDrop={async (event) => {
              if (!node.isDirectory) return;
              event.preventDefault();
              event.stopPropagation();
              setDragOverPath(null);
              const internalPath = event.dataTransfer.getData('text/x-eukolia-path');
              if (internalPath && internalPath !== node.path) {
                try {
                  const target = await actions.move(internalPath, node.path);
                  setStatusMessage(`Moved to ${target.replace(/^.*[\\/]/, '')}`);
                } catch (err) {
                  setStatusMessage(`Failed to move: ${err instanceof Error ? err.message : String(err)}`);
                }
                return;
              }
              if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                for (const file of Array.from(event.dataTransfer.files)) {
                  const filePath = window.eukoliaApi.getPathForFile(file);
                  if (filePath) {
                    try {
                      const target = await actions.importFile(filePath, node.path);
                      setStatusMessage(`Imported ${target.split(/[\\/]/).pop()}`);
                    } catch (err) {
                      setStatusMessage(`Failed to import: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                }
              }
            }}
            onClick={() => (node.isDirectory ? toggle(node.path) : openEntry(node))}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ node, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190) });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (node.isDirectory) toggle(node.path);
                else openEntry(node);
              } else if (event.key === 'ArrowRight' && node.isDirectory && !isOpen) {
                event.preventDefault();
                toggle(node.path);
              } else if (event.key === 'ArrowLeft' && node.isDirectory && isOpen) {
                event.preventDefault();
                toggle(node.path);
              } else if (event.key === 'F2') {
                event.preventDefault();
                setRenaming(node.path);
              } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                // The same menu the mouse opens, reachable from the keyboard.
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ node, x: Math.min(rect.left + 24, window.innerWidth - 190), y: Math.min(rect.top + 12, window.innerHeight - 190) });
              }
            }}
            style={{
              // --- asserted inline styles. --------------------------------
              // `tests/ui/explorer-view.test.ts` reads `style.background` back
              // off this element: the document open in the editor must be
              // exactly `var(--eu-bg-selection-list)`, a drag target the same,
              // and *every other row exactly `transparent`*. Hover and press
              // therefore cannot come from here — they are a translucent
              // `background-image` wash in the stylesheet, which composes with
              // this value instead of competing with it.
              background: dragOverPath === node.path || isActive ? 'var(--eu-bg-selection-list)' : 'transparent',
              // The indent. Computed per render from the depth and the 2px pill
              // inset, so a class cannot carry it; the guides in the stylesheet
              // are positioned from this same 12px step.
              paddingLeft: indent,
              // A drop in progress is the only state here that has an outcome,
              // and it is transient by definition.
              outline: dragOverPath === node.path ? '1px dashed var(--eu-accent)' : 'none'
            }}
          >
            {node.isDirectory ? (
              <span className={isOpen ? 'eu-sidebar-tree__chevron eu-sidebar-tree__chevron--open' : 'eu-sidebar-tree__chevron'}>
                <ChevronRight size={12} strokeWidth={2} />
              </span>
            ) : (
              <span className="eu-sidebar-tree__spacer" />
            )}
            <span className="eu-sidebar-tree__icon">{icon}</span>
            <span
              className="eu-sidebar-tree__name eu-truncate"
              data-testid="explorer-row-name"
              style={{
                // --- asserted inline styles. ------------------------------
                // The same test file reads both of these back: the file the
                // PDF *viewer* is showing must carry `color:
                // 'var(--eu-accent)'` and a weight of 600 or more, while the
                // document open in the editor — and every inactive row — must
                // carry *neither* (`style.color === ''`,
                // `style.fontWeight === ''`). That second half is the reason
                // the default colour and weight are set by the class and only
                // the PDF case is written here: a default stated inline would
                // show up in the assertion as a value that is not empty.
                //
                // The marks are different *shapes*, not two shades of one,
                // because they answer different questions: the editor's file
                // fills its row (above), the viewer's colours its own name and
                // leaves the row plain. Weight travels with the colour because
                // a theme has one accent to spend and it can sit close to the
                // body text — hue alone is not enough of a distinction at 12px.
                ...(isActivePdf ? { color: 'var(--eu-accent)', fontWeight: 600 } : undefined)
              }}
            >
              {node.name}
            </span>
          </div>
          {node.isDirectory && isOpen && node.children && node.children.length > 0 && renderNodes(node.children, depth + 1)}
          {node.isDirectory && isOpen && creating && createParent === node.path && renderCreateRow(node.path, depth + 1)}
        </React.Fragment>
      );
    });

  const rootMenuItems: Array<{ label: string; title: string; danger?: boolean; run(): void }> = menu
    ? [
        ...(menu.node.isDirectory
          ? [
              {
                label: 'New File Here',
                title: `Create a file inside ${menu.node.name}`,
                run: () => {
                  setMenu(null);
                  startCreate('file', menu.node.path);
                }
              },
              {
                label: 'New Folder Here',
                title: `Create a folder inside ${menu.node.name}`,
                run: () => {
                  setMenu(null);
                  startCreate('folder', menu.node.path);
                }
              }
            ]
          : []),
        {
          label: 'Rename',
          title: 'Rename this entry (F2)',
          run: () => {
            setMenu(null);
            setRenaming(menu.node.path);
          }
        },
        {
          label: 'Duplicate',
          title: 'Copy this entry next to itself',
          run: () => {
            setMenu(null);
            void actions.duplicate(menu.node.path).then((target) => setStatusMessage(`Created ${target.replace(/^.*[\\/]/, '')}`));
          }
        },
        {
          label: confirmDelete ? 'Confirm delete' : 'Delete',
          title: 'Move this entry to the recycle bin',
          danger: true,
          run: () => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            void actions.remove(menu.node.path).then(() => {
              setStatusMessage(`Deleted ${menu.node.name}`);
              setMenu(null);
            });
          }
        },
        {
          label: 'Copy Path',
          title: 'Copy the absolute path to the clipboard',
          run: () => {
            void actions
              .copyPath(menu.node.path)
              .then(() => setStatusMessage('Path copied'))
              .catch(() => setStatusMessage(menu.node.path));
            setMenu(null);
          }
        },
        {
          label: 'Reveal in Explorer',
          title: 'Show this entry in the system file manager',
          run: () => {
            void actions.reveal(menu.node.path).catch((err: unknown) => setStatusMessage(err instanceof Error ? err.message : String(err)));
            setMenu(null);
          }
        }
      ]
    : [];

  return (
    <div className="eu-sidebar-panel">
      <ViewHeader title="Explorer">
        <IconButton title="New File" onClick={() => startCreate('file', null)}>
          <FilePlus size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton title="New Folder" onClick={() => startCreate('folder', null)}>
          <FolderPlus size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton title="Refresh the project tree" onClick={() => void actions.refresh()}>
          <RefreshCw size={13} strokeWidth={1.8} />
        </IconButton>
        <IconButton title="Collapse all folders" onClick={() => setExpanded(new Set())}>
          <ChevronsDownUp size={13} strokeWidth={1.8} />
        </IconButton>
      </ViewHeader>

      <ScrollArea className="eu-sidebar-panel__scroll">
        {workspace.workspacePath === null ? (
          <div className="eu-sidebar-panel__body">
            <EmptyHint>No folder is open.</EmptyHint>
            <button type="button" onClick={() => void openFolder()} title="Choose a folder to open as the project" className="eu-btn eu-btn-secondary">
              Open Folder…
            </button>
          </div>
        ) : (
          <>
            {/*
              The full path of the open project.

              The tree below shows file *names*, and every nested row is relative
              to a root that was previously only inferable from the header's
              one-word title. Two projects can share a folder name, and the same
              project can be open from two checkouts, so the absolute path is the
              only thing that answers "which folder am I actually editing?".
              It is monospaced because it is a path and gets read character by
              character, and muted because it is orientation, not content.
            */}
            <div className="eu-sidebar-project-path" data-testid="explorer-project-path" title={workspace.workspacePath}>
              <Folder size={12} strokeWidth={1.8} />
              <span>{workspace.workspacePath}</span>
            </div>
            <div
              className="eu-sidebar-tree"
              role="tree"
              aria-label="Project files"
              onDragOver={(event) => {
                if (workspace.workspacePath) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={async (event) => {
                if (!workspace.workspacePath) return;
                event.preventDefault();
                setDragOverPath(null);
                const internalPath = event.dataTransfer.getData('text/x-eukolia-path');
                if (internalPath && internalPath !== workspace.workspacePath) {
                  try {
                    const target = await actions.move(internalPath, workspace.workspacePath);
                    setStatusMessage(`Moved to ${target.replace(/^.*[\\/]/, '')}`);
                  } catch (err) {
                    setStatusMessage(`Failed to move: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  return;
                }
                if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                  for (const file of Array.from(event.dataTransfer.files)) {
                    const filePath = window.eukoliaApi.getPathForFile(file);
                    if (filePath) {
                      try {
                        const target = await actions.importFile(filePath, workspace.workspacePath);
                        setStatusMessage(`Imported ${target.split(/[\\/]/).pop()}`);
                      } catch (err) {
                        setStatusMessage(`Failed to import: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }
                  }
                }
              }}
            >
              {creating && createParent === null && renderCreateRow(null, 0)}
              {renderNodes(displayTree, 0)}
              {displayTree.length === 0 && (
                // The two ways this can be empty are worth separating: a folder
                // with nothing in it, and a folder whose every file the Explorer's
                // file-type filter hides. The second looks like a bug unless it is
                // named, and the setting is the way out of it.
                <EmptyHint>
                  {fileTree.length === 0
                    ? 'This folder is empty.'
                    : 'No files match the Explorer file types. Add extensions to files.explorerInclude in Settings to show them.'}
                </EmptyHint>
              )}
            </div>
          </>
        )}
      </ScrollArea>

      {menu && (
        <div
          className="eu-popover eu-sidebar-context-menu"
          role="menu"
          aria-label={`Actions for ${menu.node.name}`}
          onMouseDown={(event) => event.stopPropagation()}
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 300 }}
        >
          <div className="eu-sidebar-context-menu__title">{menu.node.name}</div>
          {rootMenuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              title={item.title}
              onClick={item.run}
              className={item.danger ? 'eu-sidebar-context-menu__item eu-sidebar-context-menu__item--danger' : 'eu-sidebar-context-menu__item'}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

/** Where a row sits, in the dialog's viewport coordinates. */
export interface OutlineAnchor {
  /** Left edge of the row, so the dialog lines up with the heading. */
  x: number;
  /** Bottom edge of the row, so the dialog opens just beneath it. */
  y: number;
  /** Top edge of the row, so the dialog can flip above it near the foot. */
  top: number;
}

/** The dialog's frame, decided purely so it can be tested without a window. */
export interface OutlineDialogLayout {
  left: number;
  width: number;
  maxHeight: number;
  /** Down from the row's bottom, or up from its top when it opens above. */
  offsetY: number;
  /** `translateY(-100%)` when the dialog opens above its row. */
  flipAbove: boolean;
}

/**
 * Where a heading's dialog sits, and how wide.
 *
 * Kept out of the component because it is the only arithmetic the panel does,
 * and because both halves of it are easy to get wrong in ways a screenshot
 * hides:
 *
 *  * anchored to the heading's left edge, a dialog would run off the right of
 *    the window for a heading in a sidebar dragged to its widest, and the label
 *    it exists to show would be the part cut off — hence the clamp;
 *  * opened downwards from a heading near the foot of the window, it would be
 *    pushed off the bottom — hence the flip, which is expressed as a transform
 *    so the element never has to be measured before it is placed.
 */
export function outlineDialogLayout(
  anchor: OutlineAnchor,
  viewport: { width: number; height: number },
  size = { width: 300, maxHeight: 220 },
  margin = 8
): OutlineDialogLayout {
  const { width, maxHeight } = size;
  const roomBelow = viewport.height - anchor.y;

  return {
    left: Math.max(margin, Math.min(anchor.x, Math.max(margin, viewport.width - width - margin))),
    width,
    maxHeight,
    offsetY: roomBelow >= maxHeight + margin ? 6 : -6,
    flipAbove: roomBelow < maxHeight + margin
  };
}

const OutlineView: React.FC = () => {
  const { outline, revealInEditor, activeDocument } = useAppState();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  /**
   * The heading whose dialog is open, and where.
   *
   * One dialog for the whole list rather than one per row: it is positioned in
   * the viewport's coordinates so the scroll box's `overflow: hidden` cannot
   * clip it, and a single element means there is never more than one open.
   */
  const [anchor, setAnchor] = useState<{ item: OutlineItem; box: OutlineAnchor } | null>(null);

  const open = useCallback((item: OutlineItem, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setAnchor({ item, box: { x: rect.left, y: rect.bottom + 4, top: rect.top - 4 } });
  }, []);

  // A dialog anchored to the viewport has to close when that anchor moves, or it
  // is left pointing at whatever scrolled into the space it occupies.
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);

  const key = (item: OutlineItem) => `${item.line}:${item.offset}`;

  const renderItems = (items: readonly OutlineItem[]): React.ReactNode =>
    items.map((item) => {
      const id = key(item);
      const hasChildren = item.children.length > 0;
      const isCollapsed = collapsed.has(id);
      const heading = item.title || '(untitled)';
      // What the dialog exists to carry. A heading with no labels still gets one
      // — the command and the line are worth having, and a tooltip that appears
      // for some rows and not others reads as broken.
      const described = `${item.command}${item.starred ? '*' : ''} · line ${item.line}${
        item.labels.length > 0 ? ` · ${item.labels.length} label${item.labels.length === 1 ? '' : 's'}` : ''
      }`;

      return (
        <React.Fragment key={id}>
          <div
            className="eu-sidebar-outline__row"
            role="treeitem"
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            aria-label={`${heading}. ${described}`}
            tabIndex={0}
            data-outline-command={item.command}
            data-outline-level={item.level}
            onMouseEnter={(event) => open(item, event.currentTarget)}
            onMouseLeave={() => setAnchor(null)}
            // Keyboard parity: a dialog only a mouse can reach is one half the
            // readers do not have. `focusin`/`focusout` cover tabbing into a row
            // and into the chevron button inside it.
            onFocus={(event) => open(item, event.currentTarget)}
            onBlur={() => setAnchor(null)}
            onClick={() => revealInEditor(item.line, 1)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                revealInEditor(item.line, 1);
              } else if (event.key === 'ArrowRight' && hasChildren && isCollapsed) {
                event.preventDefault();
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  next.delete(id);
                  return next;
                });
              } else if (event.key === 'ArrowLeft' && hasChildren && !isCollapsed) {
                event.preventDefault();
                setCollapsed((previous) => new Set(previous).add(id));
              } else if (event.key === 'Escape') {
                setAnchor(null);
              }
            }}
            style={{
              // --- asserted inline styles. --------------------------------
              // `tests/ui/outline-view.test.ts` reads `style.height` off every
              // row and requires exactly `20px`, and it reads `paddingLeft` off
              // a parent and its first child and requires their difference to be
              // exactly 10. Both are therefore stated here and nowhere else —
              // the row's colour, weight, tracking, hover and radius are all in
              // the stylesheet, but its geometry is a contract.
              height: 20,
              paddingLeft: 4 + item.level * 10,
              // A starred heading (`\section*`) is italic: LaTeX will not number
              // it, and that is a fact about *this* heading rather than a rule
              // for all of them — the one genuinely per-render value of the
              // three, and the reason this stays a style object rather than
              // becoming two class variants.
              ...(item.starred ? { fontStyle: 'italic' as const } : undefined)
            }}
          >
            {hasChildren ? (
              <button
                type="button"
                title={isCollapsed ? 'Expand' : 'Collapse'}
                aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                aria-expanded={!isCollapsed}
                onClick={(event) => {
                  event.stopPropagation();
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                className="eu-sidebar-outline__chevron"
              >
                {isCollapsed ? <ChevronRight size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
              </button>
            ) : (
              <span className="eu-sidebar-outline__spacer" />
            )}
            {/*
              The title takes every pixel the row has. It used to be left at its
              natural width with the label chips after it, so it truncated at
              whatever the chips left over — which was nothing, because a
              `flexShrink: 0` chip never yields. That is the blank gutter and the
              needlessly clipped "Formal lan…" in one line of CSS.

              The three declarations below stay inline because the same test
              reads this element's `style` attribute as text and requires it to
              contain `flex:1`, `min-width:0` and `text-overflow:ellipsis`: they
              are the assertion's subject, not an implementation detail of it.
            */}
            <span className="eu-sidebar-outline__title" style={outlineTitle}>{heading}</span>
          </div>
          {hasChildren && !isCollapsed && renderItems(item.children)}
        </React.Fragment>
      );
    });

  return (
    <div className="eu-sidebar-panel">
      <ViewHeader title="Outline" />
      <ScrollArea className="eu-sidebar-panel__scroll">
        <div className="eu-sidebar-outline">
          {!activeDocument && <EmptyHint>Open a document to see its structure.</EmptyHint>}
          {activeDocument && outline.length === 0 && <EmptyHint>This document has no sectioning commands yet.</EmptyHint>}
          {renderItems(outline)}
        </div>
      </ScrollArea>
      {anchor && <OutlineDialog item={anchor.item} box={anchor.box} />}
    </div>
  );
};

/**
 * What a heading carries that the row has no space to say: its labels, its
 * command and its line.
 *
 * The `\label`s are the point. They were inline chips until the tree became a
 * list of titles — a chip per label crowded every heading down to an ellipsis
 * while the column beside it sat empty, so for a LaTeX author they have moved
 * from "always in the way" to "there when you look".
 */
const OutlineDialog: React.FC<{ item: OutlineItem; box: OutlineAnchor }> = ({ item, box }) => {
  // Placement is pure and runs on render: the row it belongs to is under the
  // cursor, so a layout effect would only add a frame where the dialog is in the
  // wrong place. Opening above is a transform, so nothing has to be measured.
  const layout = outlineDialogLayout(box, { width: window.innerWidth, height: window.innerHeight });
  const command = `${item.command}${item.starred ? '*' : ''}`;

  return (
    <div
      className="eu-popover eu-sidebar-dialog"
      role="tooltip"
      data-testid="outline-dialog"
      style={{
        // Placement is the anchor, and every value here is computed from where
        // the row happened to be when the pointer reached it: a class cannot say
        // "under this heading, or above it when there is no room below".
        position: 'fixed',
        left: layout.left,
        top: layout.flipAbove ? box.top : box.y,
        transform: layout.flipAbove ? 'translateY(-100%)' : undefined,
        width: layout.width,
        maxHeight: layout.maxHeight,
        marginTop: layout.offsetY,
        zIndex: 260
      }}
    >
      <div className="eu-sidebar-dialog__title">{item.title || '(untitled)'}</div>

      <div className="eu-sidebar-dialog__meta">
        <code className="eu-sidebar-dialog__command">\{command}</code>
        <span>line {item.line}</span>
      </div>

      {item.labels.length > 0 && (
        <div className="eu-sidebar-dialog__labels">
          {item.labels.map((label) => (
            <code key={label} className="eu-sidebar-dialog__label">
              {label}
            </code>
          ))}
        </div>
      )}

      <div className="eu-sidebar-dialog__hint">Click to jump to this heading</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Project search
// ---------------------------------------------------------------------------

/** Renders a search hit's line with the matched text emphasised. */
export function highlightSearchHit(hit: SearchHit): React.ReactNode {
  const start = Math.max(0, hit.column - 1);
  const end = start + Math.max(0, hit.matchLength);
  if (hit.matchLength <= 0 || start >= hit.text.length) return hit.text;
  // The match is a bare `<mark>`: its emphasis is the one thing in the results
  // list that has to be unmissable, and `.eu-sidebar-hit__text mark` states it
  // as an accent-filled chip. `mark` rather than a `span` because it is exactly
  // what the element means, and it is what the pure test asserts on.
  return (
    <>
      {hit.text.slice(0, start)}
      <mark>{hit.text.slice(start, end)}</mark>
      {hit.text.slice(end)}
    </>
  );
}

const SearchView: React.FC = () => {
  const { search, setSearch, runSearch, replaceAll, goToSource, workspace } = useAppState();

  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of search.results) {
      const list = map.get(hit.path);
      if (list) list.push(hit);
      else map.set(hit.path, [hit]);
    }
    return [...map.entries()];
  }, [search.results]);

  const relative = useCallback(
    (path: string) => {
      const root = workspace.workspacePath;
      if (!root) return path;
      const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalized = path.replace(/\\/g, '/');
      return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : normalized;
    },
    [workspace.workspacePath]
  );

  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSearch({ query: '' });
    }
  };

  return (
    <div className="eu-sidebar-panel">
      <ViewHeader title="Search" />

      <div className="eu-sidebar-panel__body">
        {/*
          What this searches, said once and in place.

          The panel previously offered a bare `*.tex` placeholder with no
          indication that it is a *filter on top of* the search — so a query that
          only appears in a `.md`, `.bib` or `.py` file returned nothing, and
          nothing on screen explained why. The scope is the contents of the open
          project; this line states that, and names the filter in force.
        */}
        <div
          className="eu-sidebar-scope"
          data-testid="search-scope"
          title={workspace.workspacePath ? `Searching the contents of ${workspace.workspacePath}` : 'Open a folder to search its contents'}
        >
          {search.include.trim()
            ? `Contents of ${workspace.workspaceName ?? 'the project'} · files matching ${search.include.trim()}`
            : `Contents of ${workspace.workspaceName ?? 'the project'} · all text files`}
        </div>

        {/*
          The query and the replacement are two `.eu-input` fields, each with the
          button that acts on it beside it. That pairing is the whole point of the
          layout: the glyph on the right of a row is what that row's text does,
          so "run this search" sits on the search row and "replace every match"
          sits on the replacement row, rather than both living in a toolbar the
          reader has to map back onto the fields.
        */}
        <div className="eu-sidebar-search-row">
          <input
            className="eu-input eu-sidebar-panel__field"
            value={search.query}
            onChange={(event) => setSearch({ query: event.target.value })}
            onKeyDown={onQueryKeyDown}
            placeholder="Search the project"
            aria-label="Search query"
            title="Search the contents of the open project (Enter runs the search)"
            spellCheck={false}
          />
          <button
            type="button"
            className="eu-icon-btn eu-pressable eu-sidebar-field-btn"
            title="Run the search"
            aria-label="Run the search"
            disabled={search.running || search.query.trim().length === 0}
            onClick={() => void runSearch()}
          >
            <Search size={13} strokeWidth={1.8} />
          </button>
        </div>

        <div className="eu-sidebar-search-row">
          <input
            className="eu-input eu-sidebar-panel__field"
            value={search.replace}
            onChange={(event) => setSearch({ replace: event.target.value })}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Replace with"
            aria-label="Replacement text"
            title="Replacement text used by Replace All"
            spellCheck={false}
          />
          <button
            type="button"
            className="eu-icon-btn eu-pressable eu-sidebar-field-btn"
            title="Replace every match in the project"
            aria-label="Replace all matches"
            disabled={search.running || search.query.trim().length === 0}
            onClick={() => void replaceAll()}
          >
            <ReplaceAll size={13} strokeWidth={1.8} />
          </button>
        </div>

        {/*
          The three match modes as chips, then the file filter.

          They were 22px squares with a border each, which read as three
          separate controls doing three unrelated things; as a row of chips they
          read as what they are — three settings of one search. `.eu-chip` states
          its own pressed treatment against `aria-pressed`, which these buttons
          already published, so the on/off colour comes from the design system
          rather than from a second copy of it.
        */}
        <div className="eu-sidebar-search-options">
          <ToggleButton active={search.isRegex} title="Use a regular expression" label="Regex" onClick={() => setSearch({ isRegex: !search.isRegex })}>
            <Regex size={13} strokeWidth={1.8} />
          </ToggleButton>
          <ToggleButton active={search.caseSensitive} title="Match case" label="Match case" onClick={() => setSearch({ caseSensitive: !search.caseSensitive })}>
            <CaseSensitive size={13} strokeWidth={1.8} />
          </ToggleButton>
          <ToggleButton active={search.wholeWord} title="Match whole words only" label="Whole word" onClick={() => setSearch({ wholeWord: !search.wholeWord })}>
            <WholeWord size={13} strokeWidth={1.8} />
          </ToggleButton>
          <input
            className="eu-input eu-sidebar-search-options__glob"
            value={search.include}
            onChange={(event) => setSearch({ include: event.target.value })}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="*.tex, *.md"
            aria-label="Include glob"
            title="Which files to search, as globs — *.tex, *.md, chapters/*.tex, or * for every text file. Leave empty to search all of them."
            spellCheck={false}
          />
        </div>

        <div className="eu-sidebar-meta">
          {search.running && <span>Searching…</span>}
          {!search.running && search.durationMs > 0 && (
            <span title={`${search.filesScanned} file(s) read`}>
              {search.results.length} results in {search.durationMs} ms
            </span>
          )}
          {search.truncated && <span className="eu-sidebar-meta--warning">truncated</span>}
          {search.error && <span className="eu-sidebar-meta--error">{search.error}</span>}
        </div>
      </div>

      <ScrollArea className="eu-sidebar-panel__scroll">
        {groups.map(([path, hits]) => (
          <div key={path}>
            {/*
              The file band. `.eu-section` is the design system's sticky band —
              opaque, uppercase, 24px — and the extra class adds only what a
              result *group* needs that a generic section does not: the file's own
              type icon, and a name that must not be upper-cased, because
              `main.TEX` is a different file from `main.tex`.
            */}
            <div className="eu-section eu-sidebar-hit-group" title={path}>
              <span className="eu-sidebar-hit-group__icon">{renderTabIcon(path.replace(/^.*[\\/]/, ''))}</span>
              <span className="eu-sidebar-hit-group__name">{path.replace(/^.*[\\/]/, '')}</span>
              <span className="eu-sidebar-hit-group__dir">{relative(path)}</span>
              <span className="eu-sidebar-hit-group__count">{hits.length}</span>
            </div>
            {hits.map((hit, index) => (
              <div
                key={`${hit.line}-${hit.column}-${index}`}
                className="eu-sidebar-hit"
                role="button"
                tabIndex={0}
                title={`${path}:${hit.line}:${hit.column} — open this match`}
                onClick={() => void goToSource(hit.path, hit.line, hit.column)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void goToSource(hit.path, hit.line, hit.column);
                  }
                }}
              >
                {/* The line number in its own fixed, right-aligned gutter, so a
                    file's matches read as a column of positions and not as a
                    paragraph each beginning with a digit. */}
                <span className="eu-sidebar-hit__line">{hit.line}</span>
                <span className="eu-sidebar-hit__text">{highlightSearchHit(hit)}</span>
              </div>
            ))}
          </div>
        ))}
        {!search.running && search.results.length === 0 && !search.error && (
          <EmptyHint>
            {search.query.trim()
              ? search.filesScanned > 0
                ? `No matches in ${search.filesScanned} file(s). ${
                    search.include.trim() ? `Only files matching ${search.include.trim()} were searched — clear the filter to search every text file.` : ''
                  }`
                : 'No files were searched. Check the include filter, or that the project folder is open.'
              : 'Type a query and press Enter to search the contents of the open project.'}
          </EmptyHint>
        )}
      </ScrollArea>
    </div>
  );
};

/**
 * One search mode, as a chip.
 *
 * `.eu-chip` reads its state from `aria-pressed`, which this control already
 * published, so the on/off treatment is the design system's rather than a
 * second copy of it — and the same chip is used everywhere else in the
 * application that toggles something, which is what makes "this one is on"
 * legible without reading the label.
 */
const ToggleButton: React.FC<{
  active: boolean;
  title: string;
  label: string;
  onClick(): void;
  children: React.ReactNode;
}> = ({ active, title, label, onClick, children }) => (
  <button
    type="button"
    className="eu-chip eu-sidebar-chip"
    title={`${title} (${active ? 'on' : 'off'})`}
    aria-label={label}
    aria-pressed={active}
    onClick={onClick}
  >
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

interface SymbolEntry {
  id: string;
  name: string;
  detail?: string;
  file: string | null;
  line: number | null;
  kind: 'label' | 'citation' | 'macro' | 'environment';
}

const SymbolsView: React.FC = () => {
  const { goToSource } = useAppState();
  const [filter, setFilter] = useState('');

  const entries = useMemo<SymbolEntry[]>(
    () => [
      ...projectIndex.getLabels().map<SymbolEntry>((label) => ({
        id: `label:${label.file}:${label.line}:${label.name}`,
        name: label.name,
        detail: label.section,
        file: label.file,
        line: label.line,
        kind: 'label'
      })),
      ...projectIndex.getBibEntries().map<SymbolEntry>((entry) => ({
        id: `citation:${entry.key}`,
        name: entry.key,
        detail: [entry.title, entry.year].filter(Boolean).join(' · ') || entry.type,
        file: entry.source || null,
        line: entry.line || null,
        kind: 'citation'
      })),
      ...projectIndex.getMacros().map<SymbolEntry>((macro) => ({
        id: `macro:${macro.file}:${macro.line}:${macro.name}`,
        name: `\\${macro.name}`,
        detail: macro.args > 0 ? `${macro.args} argument${macro.args === 1 ? '' : 's'}` : undefined,
        file: macro.file,
        line: macro.line,
        kind: 'macro'
      })),
      ...projectIndex.getEnvironmentNames().map<SymbolEntry>((name) => ({
        id: `environment:${name}`,
        name,
        file: null,
        line: null,
        kind: 'environment'
      }))
    ],
    []
  );

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => `${entry.name} ${entry.detail ?? ''} ${entry.file ?? ''}`.toLowerCase().includes(needle));
  }, [entries, filter]);

  const groups: Array<{ key: SymbolEntry['kind']; title: string; icon: React.ReactNode }> = [
    { key: 'label', title: 'Labels', icon: <Tag size={12} strokeWidth={1.8} /> },
    { key: 'citation', title: 'Citations', icon: <Quote size={12} strokeWidth={1.8} /> },
    { key: 'macro', title: 'Macros', icon: <SquareFunction size={12} strokeWidth={1.8} /> },
    { key: 'environment', title: 'Environments', icon: <Boxes size={12} strokeWidth={1.8} /> }
  ];

  return (
    <div className="eu-sidebar-panel">
      <ViewHeader title="Symbols" />
      <div className="eu-sidebar-panel__body">
        <input
          className="eu-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder="Filter labels, citations, macros…"
          aria-label="Filter symbols"
          title="Filter the project symbol index"
          spellCheck={false}
        />
      </div>
      <ScrollArea className="eu-sidebar-panel__scroll">
        {groups.map((group) => {
          const items = filtered.filter((entry) => entry.kind === group.key);
          if (items.length === 0) return null;
          return (
            <div key={group.key}>
              {/* The type band: same sticky `.eu-section` treatment as a search
                  result's file band and a diagnostic's file band, so the three
                  grouped lists in this sidebar are one visual idea. */}
              <div className="eu-section eu-sidebar-symbol-group">
                <span className="eu-sidebar-symbol-group__icon">{group.icon}</span>
                <span className="eu-sidebar-symbol-group__title">{group.title}</span>
                <span className="eu-sidebar-symbol-group__count">{items.length}</span>
              </div>
              {items.slice(0, 400).map((entry) => {
                const file = entry.file;
                const line = entry.line;
                if (!file || !line) {
                  // Environment names come from the index as a set of names with no
                  // single source position, so they are shown as plain chips rather
                  // than as a control that could not navigate anywhere.
                  return (
                    <div
                      key={entry.id}
                      className="eu-sidebar-symbol-row eu-sidebar-symbol-row--static"
                      title="Environment name known to the project index; it has no single source position"
                    >
                      <span className="eu-sidebar-label-chip">{entry.name}</span>
                    </div>
                  );
                }
                const jump = () => void goToSource(file, line, 1);
                return (
                  <div
                    key={entry.id}
                    className="eu-sidebar-symbol-row"
                    role="button"
                    tabIndex={0}
                    title={`${file}:${line} — go to definition`}
                    onClick={jump}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        jump();
                      }
                    }}
                  >
                    {/* A macro is shown as the command it is — monospaced and in
                        the command colour — because `\foo` and `foo` are two
                        different symbols in a LaTeX project. */}
                    <span
                      className={
                        entry.kind === 'macro'
                          ? 'eu-sidebar-symbol-row__name eu-sidebar-symbol-row__name--macro'
                          : 'eu-sidebar-symbol-row__name'
                      }
                    >
                      {entry.name}
                    </span>
                    {entry.detail && <span className="eu-sidebar-symbol-row__detail">{entry.detail}</span>}
                    <span className="eu-sidebar-symbol-row__spacer" />
                    <span className="eu-sidebar-symbol-row__line">{line}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <EmptyHint>{entries.length === 0 ? 'No symbols yet — open or create LaTeX files in this project.' : 'Nothing matches that filter.'}</EmptyHint>
        )}
      </ScrollArea>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

const ProblemsView: React.FC = () => {
  const { diagnostics, goToSource } = useAppState();
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const map = new Map<string, typeof diagnostics>();
    for (const diagnostic of diagnostics) {
      if (needle && !`${diagnostic.message} ${diagnostic.file} ${diagnostic.code ?? ''}`.toLowerCase().includes(needle)) continue;
      const list = map.get(diagnostic.file);
      if (list) list.push(diagnostic);
      else map.set(diagnostic.file, [diagnostic]);
    }
    return [...map.entries()];
  }, [diagnostics, filter]);

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;

  return (
    <div className="eu-sidebar-panel">
      {/*
        The two tallies sit in the header, where the reader is already looking
        for "how bad is it" — and as `.eu-badge`es coloured from the semantic
        tokens, so a count of zero still reads as *a count of zero* rather than as
        a stray digit. They are the same two numbers the bottom panel's Problems
        tab shows.
      */}
      <ViewHeader title="Problems">
        <span className="eu-badge eu-sidebar-header-badge eu-sidebar-badge-error" title={`${errors} error${errors === 1 ? '' : 's'}`}>
          {errors}
        </span>
        <span className="eu-badge eu-sidebar-header-badge eu-sidebar-badge-warning" title={`${warnings} warning${warnings === 1 ? '' : 's'}`}>
          {warnings}
        </span>
      </ViewHeader>
      <div className="eu-sidebar-panel__body">
        <input
          className="eu-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder="Filter problems"
          aria-label="Filter problems"
          title="Filter the compiler diagnostics"
          spellCheck={false}
        />
      </div>
      <ScrollArea className="eu-sidebar-panel__scroll">
        {groups.map(([file, items]) => (
          <div key={file}>
            {/* The same sticky file band the Search panel's results use, so a
                long list of diagnostics stays anchored to the file it is about
                while it scrolls. */}
            <div className="eu-section eu-sidebar-problem-group" title={file}>
              <span className="eu-sidebar-problem-group__icon">
                <FileText size={12} strokeWidth={1.8} />
              </span>
              <span className="eu-sidebar-problem-group__name">{file.replace(/^.*[\\/]/, '')}</span>
              <span className="eu-sidebar-problem-group__count">{items.length}</span>
            </div>
            {items.map((diagnostic, index) => (
              <div
                key={`${diagnostic.line}-${index}`}
                className="eu-sidebar-problem-row"
                role="button"
                tabIndex={0}
                title={`${file}:${diagnostic.line} — go to this problem`}
                onClick={() => void goToSource(diagnostic.file, diagnostic.line, diagnostic.column ?? 1)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void goToSource(diagnostic.file, diagnostic.line, diagnostic.column ?? 1);
                  }
                }}
              >
                {severityIcon(diagnostic.severity)}
                <span className="eu-sidebar-problem-row__text">
                  <span className="eu-sidebar-problem-row__message">{diagnostic.message}</span>
                  {/* `file:line:col · source` — the provenance, in tabular
                      figures because it is a position and two rows' worth of
                      positions should line up when they are read as a column. */}
                  <span className="eu-sidebar-problem-row__where">
                    {file.replace(/^.*[\\/]/, '')}:{diagnostic.line}
                    {diagnostic.column ? `:${diagnostic.column}` : ''} · {diagnostic.source}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && <EmptyHint>{diagnostics.length === 0 ? 'No problems reported.' : 'Nothing matches that filter.'}</EmptyHint>}
      </ScrollArea>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Snippet history
// ---------------------------------------------------------------------------

/**
 * The snippets panel: what has actually fired, newest first.
 *
 * This used to list the *library* — every trigger the engine knows — which
 * answered a question the completion list already answers at the caret, and
 * answered it worst for the case that actually needs help: a snippet that has
 * just done something unexpected. The history answers that one directly. Each
 * row names the snippet and when it fired; the hover dialog shows the text it
 * put in the document and what the library holds for it; clicking opens that
 * entry in the manager, selected, ready to change.
 */
const SnippetsView: React.FC = () => {
  const { setStatusMessage, toggleSnippets, openSnippetInManager } = useAppState();
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState<{ entry: SnippetHistoryEntry; box: OutlineAnchor } | null>(null);
  // A relative timestamp is only honest if it moves. The tick is deliberately
  // slow: seconds matter for "did that just happen?", and a one-second interval
  // would re-render the list sixty times a minute to say so.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const store = getSnippetStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const entries = useSyncExternalStore(snippetHistory.subscribe, snippetHistory.entries, snippetHistory.entries);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      `${entry.trigger} ${entry.description} ${entry.sourceName} ${entry.snippetId ?? ''}`.toLowerCase().includes(needle)
    );
  }, [filter, entries]);

  const open = useCallback((entry: SnippetHistoryEntry, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setAnchor({ entry, box: { x: rect.left, y: rect.bottom + 4, top: rect.top - 4 } });
  }, []);

  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);

  /**
   * Opens the entry in the manager.
   *
   * A snippet from a hand-written `.hsnips` file has no library entry to open, so
   * that case says so rather than opening the manager at nothing and leaving the
   * reader to guess which of several hundred rows was meant.
   */
  const openInManager = useCallback(
    (entry: SnippetHistoryEntry) => {
      if (!entry.snippetId) {
        setStatusMessage(`${entry.trigger} comes from ${entry.sourceName.replace(/^.*[\\/]/, '')}, not the managed library`);
        return;
      }
      if (window.eukoliaApi?.openSnippetsWindow) {
        void window.eukoliaApi.openSnippetsWindow(entry.snippetId);
      } else {
        openSnippetInManager(entry.snippetId);
      }
    },
    [openSnippetInManager, setStatusMessage]
  );

  return (
    <div className="eu-sidebar-panel">
      <ViewHeader title="Snippet history">
        <IconButton title="Clear the trigger history" disabled={entries.length === 0} onClick={() => snippetHistory.clear()}>
          <Trash2 size={13} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          title="Reload the snippet library from disk and settings"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void reloadSnippets()
              .then(() => setStatusMessage('Snippets reloaded'))
              .catch((err: unknown) => setStatusMessage(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          <RotateCw size={13} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          title="Manage snippets — opens the snippet library window (Ctrl+Alt+L)"
          onClick={() => {
            if (window.eukoliaApi?.openSnippetsWindow) {
              void window.eukoliaApi.openSnippetsWindow();
            } else {
              toggleSnippets();
            }
          }}
        >
          <SettingsIcon size={13} strokeWidth={1.8} />
        </IconButton>
      </ViewHeader>

      <div className="eu-sidebar-panel__body">
        <input
          className="eu-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder="Filter by trigger, id or description"
          aria-label="Filter snippet history"
          title="Filter the history by trigger, id, description or source file"
          spellCheck={false}
        />
      </div>

      <ScrollArea className="eu-sidebar-panel__scroll">
        {/*
          What the list is showing: how many expansions are in view, then which
          snippet file they came from. Two lines rather than one because the
          second is a *path*, and a path that is truncated from the wrong end is
          useless — so it gets the full width and its own line.
        */}
        <div className="eu-sidebar-history__summary">
          <div>
            {filtered.length}
            {filtered.length === 1 ? ' expansion' : ' expansions'}
            {snippetHistory.total() > entries.length ? ` · last ${entries.length} of ${snippetHistory.total()}` : ''}
          </div>
          <div className="eu-sidebar-history__language" title={state.path}>
            {store.language}
            {state.parseError && <span className="eu-sidebar-history__problem">{` · ${state.parseError.split('\n')[0]}`}</span>}
          </div>
        </div>

        {filtered.map((entry) => (
          <div
            key={entry.sequence}
            className="eu-sidebar-history__row"
            role="button"
            tabIndex={0}
            data-testid="snippet-history-row"
            data-snippet-id={entry.snippetId ?? ''}
            data-snippet-trigger={entry.trigger}
            aria-label={`${entry.trigger}. ${entry.description || 'no description'}. ${formatSince(entry.at, now)}.`}
            title={`${entry.trigger} — ${formatClockTime(entry.at)}`}
            onMouseEnter={(event) => open(entry, event.currentTarget)}
            onMouseLeave={() => setAnchor(null)}
            onFocus={(event) => open(entry, event.currentTarget)}
            onBlur={() => setAnchor(null)}
            onClick={() => openInManager(entry)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openInManager(entry);
              } else if (event.key === 'Escape') {
                setAnchor(null);
              }
            }}
          >
            <Zap size={11} strokeWidth={1.8} className="eu-sidebar-history__glyph" />
            <span className="eu-sidebar-history__id" title={entry.snippetId ?? entry.trigger}>
              {entry.snippetId ?? entry.trigger}
            </span>
            <span className="eu-sidebar-history__preview">{summariseExpansion(entry.inserted, 34) || '(empty)'}</span>
            <span className="eu-sidebar-history__spacer" />
            {/* Relative on the right, the clock time in the tooltip: "4m" is what
                answers "did that just happen?", and it is a quantity, so it is
                set in tabular figures to stop the column twitching. */}
            <span className="eu-sidebar-history__time" title={formatClockTime(entry.at)}>
              {formatSince(entry.at, now)}
            </span>
          </div>
        ))}

        {entries.length === 0 && (
          <EmptyHint>
            No snippet has expanded yet. Triggers appear here as they fire, with the text each one inserted — accept a snippet
            from the completion list, or type an automatic (@a) trigger.
          </EmptyHint>
        )}
        {entries.length > 0 && filtered.length === 0 && <EmptyHint>Nothing in the history matches that filter.</EmptyHint>}
      </ScrollArea>
      {anchor && <SnippetHistoryDialog entry={anchor.entry} box={anchor.box} />}
    </div>
  );
};

/**
 * What a history row has no space for: the snippet's own body, the text that
 * actually landed in the document, and where the entry can be edited.
 */
const SnippetHistoryDialog: React.FC<{ entry: SnippetHistoryEntry; box: OutlineAnchor }> = ({ entry, box }) => {
  const layout = outlineDialogLayout(box, { width: window.innerWidth, height: window.innerHeight });
  const source = entry.sourceName.replace(/^.*[\\/]/, '') || 'unknown source';

  return (
    <div
      className="eu-popover eu-sidebar-dialog"
      role="tooltip"
      data-testid="snippet-history-dialog"
      style={{
        // The same computed anchor as the Outline's dialog, for the same reason.
        position: 'fixed',
        left: layout.left,
        top: layout.flipAbove ? box.top : box.y,
        transform: layout.flipAbove ? 'translateY(-100%)' : undefined,
        width: layout.width,
        maxHeight: layout.maxHeight,
        marginTop: layout.offsetY,
        zIndex: 260
      }}
    >
      <div className="eu-sidebar-dialog__meta eu-sidebar-dialog__meta--baseline">
        <code className="eu-sidebar-history__trigger">{entry.trigger}</code>
        {entry.snippetId && <code className="eu-sidebar-history__id-sub">{entry.snippetId}</code>}
      </div>
      {entry.description && <div className="eu-sidebar-history__description">{entry.description}</div>}
      <div className="eu-sidebar-history__meta">
        {formatClockTime(entry.at)} · {describeExpansion(entry)} · {source}
      </div>

      <SnippetDialogBlock title="Inserted">{entry.inserted || '(nothing)'}</SnippetDialogBlock>
      {entry.template && entry.template !== entry.inserted && <SnippetDialogBlock title="Snippet body">{entry.template}</SnippetDialogBlock>}

      <div className="eu-sidebar-dialog__hint">
        {entry.snippetId ? 'Click to open this snippet in the library' : 'From an imported file — not editable in the library'}
      </div>
    </div>
  );
};

const SnippetDialogBlock: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="eu-sidebar-dialog__block">
    <div className="eu-sidebar-history__block-title">{title}</div>
    <pre className="eu-sidebar-dialog__pre">{children}</pre>
  </div>
);

// ---------------------------------------------------------------------------
// Menu View
// ---------------------------------------------------------------------------

const MENU_ICONS: Record<string, React.FC<LucideProps>> = {
  File: FileText,
  Edit: Braces,
  Selection: CaseSensitive,
  View: LayoutPanelLeft,
  Go: ArrowRight,
  Run: Play,
  Terminal: TerminalSquare,
  Help: Info
};

function formatMenuShortcut(commandId: string): string {
  const binding = commandRegistry.getKeybinding(commandId);
  if (!binding) return '';
  if (commandRegistry.getBindingOwner(binding) !== commandId) return '';
  return translateKeybinding(binding);
}

const MenuView: React.FC = () => {
  const { workspace, openFolder, setStatusMessage } = useAppState();
  const [libraryStatus, setLibraryStatus] = useState<ProjectLibraryStatus | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help'])
  );

  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((v) => v + 1);
    const unbind = [
      commandRegistry.on('registered', bump),
      commandRegistry.on('unregistered', bump),
      commandRegistry.on('context', bump),
      commandRegistry.on('keybindings-changed', bump),
      settingsManager.on('change', bump)
    ];
    return () => unbind.forEach((off) => off());
  }, []);

  useEffect(() => {
    let active = true;
    window.eukoliaApi?.getProjectLibrary?.()
      ?.then((status) => {
        if (active) setLibraryStatus(status);
      })
      ?.catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const available = useMemo(() => {
    void revision;
    return commandRegistry.getAvailable();
  }, [revision]);

  const toggleSection = useCallback((label: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const allExpanded = expandedSections.size >= APP_MENUS.length;
  const toggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpandedSections(new Set());
    } else {
      setExpandedSections(new Set(APP_MENUS.map((m) => m.label)));
    }
  }, [allExpanded]);

  const query = filterQuery.trim().toLowerCase();

  const menuSections = useMemo(() => {
    return APP_MENUS.map((menu) => {
      const commands = commandsForMenu(menu, available);
      const filtered = query
        ? commands.filter(
            (c) =>
              c.title.toLowerCase().includes(query) ||
              c.id.toLowerCase().includes(query) ||
              c.category.toLowerCase().includes(query)
          )
        : commands;
      return {
        menu,
        commands: filtered,
        totalCount: commands.length
      };
    });
  }, [available, query]);

  const executeCommand = useCallback(
    (commandId: string, title: string) => {
      void commandRegistry.execute(commandId);
      setStatusMessage(`Executed: ${title}`);
    },
    [setStatusMessage]
  );

  const currentProjectName =
    workspace.workspaceName ||
    (libraryStatus?.root ? libraryStatus.root.split(/[\\/]/).pop() : '') ||
    'Your projects';

  const currentProjectPath = workspace.workspacePath || libraryStatus?.root || '';

  return (
    <div className="eu-sidebar-panel" data-testid="menu-view">
      <ViewHeader title="Menu">
        <IconButton
          title="Open Command Palette (Ctrl+Shift+P)"
          onClick={() => void commandRegistry.execute('workbench.commandPalette')}
        >
          <Search size={13} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          title={allExpanded ? 'Collapse all categories' : 'Expand all categories'}
          onClick={toggleExpandAll}
        >
          <ChevronsDownUp size={13} strokeWidth={1.8} />
        </IconButton>
      </ViewHeader>

      <ScrollArea className="eu-sidebar-panel__scroll">
        <div className="eu-sidebar-menu__body">
          {/*
            Project Library Card: Button for choosing a project in project library.

            The card and the button are the same surface on purpose — the block
            the eye reads as "this is what I am working on" is the block you press
            to change it, so switching projects is one click from the panel that
            names the current one.
          */}
          <div className="eu-card eu-sidebar-menu__project">
            <div className="eu-eyebrow eu-sidebar-menu__section-title">Project Library</div>

            <button
              type="button"
              className="eu-sidebar-menu__switch"
              data-testid="menu-project-library-button"
              title={currentProjectPath ? `Project: ${currentProjectPath}\nClick to choose or switch project` : 'Choose a project from your library'}
              onClick={() => showProjectLibrary('library')}
            >
              <div className="eu-sidebar-menu__switch-mark">
                <Library size={16} strokeWidth={2} />
              </div>
              <div className="eu-sidebar-menu__switch-text">
                <div className="eu-sidebar-menu__switch-label">ACTIVE PROJECT</div>
                <div className="eu-sidebar-menu__switch-name" title={currentProjectName}>{currentProjectName}</div>
                {currentProjectPath && (
                  <div className="eu-sidebar-menu__switch-path" title={currentProjectPath}>{currentProjectPath}</div>
                )}
              </div>
              <FolderOpen size={15} strokeWidth={1.8} className="eu-sidebar-menu__switch-glyph" />
            </button>

            {/* The two ways a project starts. Named in words rather than as two
                more glyphs: this is the one place in the panel where the reader
                may not yet know what the icons would mean. */}
            <div className="eu-sidebar-menu__quick">
              <button
                type="button"
                className="eu-btn eu-btn-secondary eu-sidebar-menu__quick-btn"
                data-testid="menu-new-project-button"
                title="Create a new project from a template (Ctrl+Alt+N)"
                onClick={() => showProjectLibrary('create')}
              >
                <FolderPlus size={13} strokeWidth={1.8} />
                <span>New Project</span>
              </button>
              <button
                type="button"
                className="eu-btn eu-btn-secondary eu-sidebar-menu__quick-btn"
                data-testid="menu-open-folder-button"
                title="Open another folder on disk (Ctrl+K Ctrl+O)"
                onClick={() => void openFolder()}
              >
                <Folder size={13} strokeWidth={1.8} />
                <span>Open Folder</span>
              </button>
            </div>
          </div>

          {/*
            Quick Command Filter & Palette.

            Built on `.eu-input`, so it focuses, borders and insets exactly like
            every other field in the application, with the glyph leading and the
            shortcut trailing — and the shortcut is a real button, because
            showing a keycap that does nothing is worse than not showing it.
          */}
          <div className="eu-input eu-sidebar-menu__command-search">
            <Search size={13} strokeWidth={1.8} />
            <input
              type="text"
              className="eu-sidebar-menu__command-input"
              data-testid="menu-filter-input"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search features & commands…"
              spellCheck={false}
            />
            {filterQuery && (
              <button
                type="button"
                className="eu-icon-btn eu-pressable eu-sidebar-menu__clear"
                title="Clear search"
                onClick={() => setFilterQuery('')}
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
            <button
              type="button"
              className="eu-sidebar-menu__palette-key"
              title="Command Palette (Ctrl+Shift+P)"
              onClick={() => void commandRegistry.execute('workbench.commandPalette')}
            >
              Ctrl+Shift+P
            </button>
          </div>

          {/* Menu Sections (File, Edit, Selection, View, Go, Run, Terminal, Help) */}
          <div className="eu-sidebar-menu__sections">
            {menuSections.map(({ menu, commands, totalCount }) => {
              const Icon = MENU_ICONS[menu.label] || ListTree;
              const isExpanded = query ? commands.length > 0 : expandedSections.has(menu.label);

              if (query && commands.length === 0) return null;

              return (
                <div
                  key={menu.label}
                  className="eu-sidebar-menu__section"
                  data-eu-open={isExpanded ? 'true' : 'false'}
                  data-testid={`menu-section-${menu.label}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSection(menu.label)}
                    className="eu-sidebar-menu__header"
                    aria-expanded={isExpanded}
                    data-testid={`menu-header-${menu.label}`}
                  >
                    {isExpanded ? (
                      <ChevronDown size={13} strokeWidth={2} className="eu-sidebar-menu__chevron" />
                    ) : (
                      <ChevronRight size={13} strokeWidth={2} className="eu-sidebar-menu__chevron" />
                    )}
                    <Icon size={14} strokeWidth={1.8} className="eu-sidebar-menu__section-icon" />
                    <span className="eu-sidebar-menu__section-label">{menu.label}</span>
                    {/* The count is a badge, and a *filtered* count reads `3/42`
                        — two different claims that have to be told apart at a
                        glance rather than in a sentence. */}
                    <span className="eu-badge eu-sidebar-menu__count">
                      {query ? `${commands.length}/${totalCount}` : commands.length}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="eu-sidebar-menu__list" data-testid={`menu-items-${menu.label}`}>
                      {commands.length === 0 ? (
                        <div className="eu-sidebar-menu__none">No commands available</div>
                      ) : (
                        commands.map((cmd) => {
                          const shortcut = formatMenuShortcut(cmd.id);
                          return (
                            <button
                              key={cmd.id}
                              type="button"
                              data-testid={`menu-item-${cmd.id}`}
                              title={`${cmd.title}${shortcut ? ` (${shortcut})` : ''} • ${cmd.id}`}
                              onClick={() => executeCommand(cmd.id, cmd.title)}
                              className="eu-sidebar-menu__command"
                            >
                              <span className="eu-sidebar-menu__command-title">{cmd.title}</span>
                              {shortcut && <span className="eu-sidebar-menu__command-shortcut">{shortcut}</span>}
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export const Sidebar: React.FC<SidebarProps> = () => {

  const { sidebarView, setSidebarView } = useAppState();

  switch (sidebarView) {
    case 'menu':
      return <MenuView />;
    case 'explorer':
      return <ExplorerView />;
    case 'outline':
      return <OutlineView />;
    case 'search':
      return <SearchView />;
    case 'symbols':
      return <SymbolsView />;
    case 'problems':
      return <ProblemsView />;
    case 'snippets':
      return <SnippetsView />;
    default:
      /*
       * Reached when the region is rendered with no view chosen. Each button is
       * `.eu-btn`, so the way back into any panel looks like every other control
       * in the application rather than like a bare `button` element.
       */
      return (
        <div className="eu-sidebar-panel">
          <ViewHeader title="No view" />
          <EmptyHint>The sidebar is hidden.</EmptyHint>
          <div className="eu-sidebar-none-actions">
            {(['menu', 'explorer', 'outline', 'search', 'symbols', 'problems', 'snippets'] as const).map((view) => (
              <button key={view} type="button" className="eu-btn eu-pressable" title={`Show ${view}`} onClick={() => setSidebarView(view)}>
                <ListTree size={12} strokeWidth={1.8} />
                {view}
              </button>
            ))}
          </div>
        </div>
      );
  }
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * The heading's own text, and the row's only flexible child.
 *
 * `flex: 1` with `minWidth: 0` is what lets it take the full width and still
 * ellipsise: without the `minWidth` a flex item refuses to shrink below its
 * content, so a long heading would push the row wider than the panel instead of
 * truncating inside it.
 *
 * It is inline rather than a class because `tests/ui/outline-view.test.ts` reads
 * this element's `style` attribute *as text* and requires it to contain
 * `flex:1`, `min-width:0` and `text-overflow:ellipsis`. The declarations are the
 * assertion's subject: moving them into the stylesheet would leave the test
 * passing on an element that no longer has them, which is the one outcome worse
 * than a failing test. The class it also carries is where the *appearance*
 * lives — colour, tracking and the italic a starred heading takes.
 */
const outlineTitle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--eu-fg-primary)'
};

export default Sidebar;
