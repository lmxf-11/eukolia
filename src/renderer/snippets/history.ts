/**
 * Eukolia — snippet trigger history.
 *
 * A record of the snippets that have actually fired, newest first. The Snippets
 * panel used to list the *library* — every trigger the engine knows, most of
 * which the author has never used and never will — which answered "what could
 * expand here?" for a question the completion list already answers on the spot.
 * What is hard to find out after the fact is the opposite: which snippet just
 * fired, what text it put in the document, and where that snippet is defined
 * when a trigger turns out to be doing the wrong thing.
 *
 * So each entry carries the identity of the snippet (`id`, falling back to its
 * trigger), the text the expansion produced, and where it landed. The preview is
 * the part a trigger name cannot give you: two snippets named `beg` in different
 * files are indistinguishable by trigger and obvious by what they insert.
 *
 * Recorded at the one choke point every expansion passes through —
 * `SnippetEditorAdapter.apply` — so manual acceptance, automatic (`A` flag)
 * firing and the Visual editor's expansions are all covered by construction
 * rather than by three call sites remembering to report.
 */

import { getSnippetBody, type HSnippet } from '../vendor/hypersnips';

/** One snippet expansion that happened. */export interface SnippetHistoryEntry {
  /** Monotonic; used as the React key and to address an entry. */
  sequence: number;
  /** The managed snippet's `id`, when the library gave it one. */
  snippetId: string | null;
  /** What identifies the snippet to a reader: its trigger. */
  trigger: string;
  description: string;
  /** Source file the snippet came from, as the engine knows it. */
  sourceName: string;
  /** The snippet's body as written, with placeholder markup. */
  template: string;
  /** The text the expansion actually inserted, placeholders resolved. */
  inserted: string;
  /** True when the engine fired this without the author accepting it. */
  automatic: boolean;
  /** Epoch milliseconds. */
  at: number;
  /** Document the expansion landed in, for context; `null` when anonymous. */
  documentUri: string | null;
  /** 1-based line the expansion started on in that document. */
  line: number;
}

/** How many expansions are kept. Enough to cover a working session. */
export const SNIPPET_HISTORY_LIMIT = 200;

export interface SnippetHistoryStore {
  /** Newest first. */
  entries(): readonly SnippetHistoryEntry[];
  record(entry: Omit<SnippetHistoryEntry, 'sequence'>): SnippetHistoryEntry;
  clear(): void;
  /** Total ever recorded, including entries dropped by the cap. */
  total(): number;
  subscribe(listener: () => void): () => void;
}

export function createSnippetHistoryStore(limit = SNIPPET_HISTORY_LIMIT): SnippetHistoryStore {
  let entries: SnippetHistoryEntry[] = [];
  let sequence = 0;
  let total = 0;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    entries: () => entries,

    record(entry) {
      sequence += 1;
      total += 1;
      const recorded: SnippetHistoryEntry = { ...entry, sequence };
      // Newest first, and capped: a history is for the last few minutes of work,
      // so an unbounded list would cost memory to store what nobody scrolls to.
      entries = [recorded, ...entries].slice(0, limit);
      emit();
      return recorded;
    },

    clear() {
      if (entries.length === 0) return;
      entries = [];
      emit();
    },

    total: () => total,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** The application's history. One document set, one history. */
export const snippetHistory = createSnippetHistoryStore();

/**
 * Records an expansion on the application's history.
 *
 * Separate from the store so the engine can be handed a plain function and stay
 * unaware of the store's existence — and so a test can drive the recording rule
 * without a DOM or a live engine.
 */
export function recordExpansion(
  store: SnippetHistoryStore,
  snippet: HSnippet,
  inserted: string,
  context: { documentUri?: string | null; line?: number; at?: number } = {}
): SnippetHistoryEntry {
  return store.record({
    snippetId: snippet.id ?? null,
    // A regex trigger has no literal text, so its pattern source is the only
    // thing a reader can be shown.
    trigger: snippet.trigger || snippet.regexp?.source || '(regex)',
    description: snippet.description,
    sourceName: snippet.sourceName,
    template: getSnippetBody(snippet) ?? '',
    inserted,
    automatic: snippet.automatic,
    at: context.at ?? Date.now(),
    documentUri: context.documentUri ?? null,
    line: context.line ?? 1
  });
}

/**
 * Files an expansion in the trigger history.
 *
 * Kept as the single entry point production uses, so the store stays the only
 * thing that knows how an entry is shaped.
 */
export function rememberExpansion(
  snippet: HSnippet,
  inserted: string,
  context: { documentUri?: string | null; line?: number; at?: number } = {}
): void {
  try {
    recordExpansion(snippetHistory, snippet, inserted, context);
  } catch {
    /* the history is a convenience; it must never break an expansion */
  }
}

/**
 * A short, single-line form of an expansion, for a list row.
 *
 * Whitespace is collapsed because a snippet body is usually several lines and the
 * row is one; the full text is what the hover preview is for. Truncation happens
 * here rather than in CSS so the entry carries a honest `…` of its own rather
 * than being cut at whatever the panel happens to be wide.
 */
export function summariseExpansion(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * How long ago, in the compact form a dense list wants.
 *
 * Deliberately coarse past a minute: the row is a glance, and "3m" answers "was
 * that just now or ages ago?" where a wall clock makes the reader do arithmetic.
 * The exact time is in the row's tooltip for the case where it matters.
 */
export function formatSince(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The wall-clock time, for the tooltip: `14:07:32`. */
export function formatClockTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * What the expansion did, in one line, for the hover preview.
 *
 * Built from what the record actually knows rather than from a guess: how many
 * characters landed, how many tab stops the author can move through, and whether
 * the engine fired it unprompted. A snippet that fired automatically is the one
 * case worth calling out, because the author did not ask for it.
 */
export function describeExpansion(entry: {
  inserted: string;
  automatic: boolean;
  sourceName: string;
}): string {
  const lines = entry.inserted.length === 0 ? 0 : entry.inserted.split('\n').length;
  const shape = lines <= 1 ? `${entry.inserted.length} characters on one line` : `${lines} lines`;
  const how = entry.automatic ? 'expanded automatically' : 'expanded when accepted';
  return `${how} — inserted ${shape}`;
}
