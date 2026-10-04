import { waitingIconUrl } from './appIcons';
/**
 * Eukolia — the surfaces that load on demand.
 *
 * The shell a person sees at launch is the title bar, the activity bar, the
 * sidebar, the tab strip and the status bar. Everything else in the window is
 * *behind* an interaction: the editor, the PDF viewer, Settings, the snippet
 * library, the terminal, the palette. Those are the larger half of the
 * application by a wide margin — the PDF viewer alone is a ported C++ viewer's
 * whole UI, the terminal is a VT emulator, and the snippet library is its own
 * editor — and none of it can be on screen before a window exists.
 *
 * So they are `React.lazy`. A dynamic import here is not a micro-optimisation:
 * it is what keeps ~1 MB of JavaScript out of the bundle the window has to parse
 * before it can draw a frame it already knows how to draw. Each one is fetched
 * the first time it is rendered, which is the first time it is needed.
 *
 * `SuspenseBoundary` is the fallback for the moment in between. A surface that is
 * loading shows the frame it will be drawn in rather than nothing, so the layout
 * does not jump when its chunk lands.
 *
 * Note what is *not* here: `Sidebar`, `StatusBar`, `ActivityBar`, `TabBar` and
 * `BottomPanel` are imported directly by `App.tsx`. They are the shell, they are
 * cheap, and deferring them would move work to the first frame rather than away
 * from it. `TabBar` least of all: it is the window's top edge, so it is the drag
 * region and the caption buttons the first frame is made of.
 */

import React, { Suspense, lazy } from 'react';
import { startupMark } from '../core/startupProbe';

/** True while a lazy chunk is being fetched, for the profiler. */
function reportChunk(name: string): void {
  startupMark(`chunk:${name}`);
}

export const LazyVisualEditor = lazy(() =>
  import('../visual/VisualEditor').then((module) => {
    reportChunk('visual-editor');
    return { default: module.VisualEditor };
  })
);

export const LazyPdfPane = lazy(() =>
  import('../pdf/PdfPane').then((module) => {
    reportChunk('pdf-pane');
    return { default: module.PdfPane };
  })
);

export const LazySettingsView = lazy(() =>
  import('./components/SettingsView').then((module) => {
    reportChunk('settings');
    return { default: module.SettingsView };
  })
);

export const LazySnippetManager = lazy(() =>
  import('./components/SnippetManager').then((module) => {
    reportChunk('snippets');
    return { default: module.SnippetManager };
  })
);

export const LazyCommandPalette = lazy(() =>
  import('./components/CommandPalette').then((module) => {
    reportChunk('palette');
    return { default: module.CommandPalette };
  })
);

export const LazyQuickOpen = lazy(() =>
  import('./components/QuickOpen').then((module) => {
    reportChunk('quick-open');
    return { default: module.QuickOpen };
  })
);

export const LazyTabSwitcher = lazy(() =>
  import('./components/TabSwitcher').then((module) => {
    reportChunk('tab-switcher');
    return { default: module.TabSwitcher };
  })
);

/**
 * The Mathematical Symbols panel.
 *
 * Lazy for a reason the other entries do not have: this panel imports the
 * generated catalog, which is a few thousand entries of JSON. Parsing it is
 * work no launch should pay — the panel is behind a click, and until that click
 * happens the catalog is bytes in a chunk nobody asked for. The dynamic import
 * is what puts it in its own chunk rather than in the shell's.
 */
export const LazyMathematicalSymbolsView = lazy(() =>
  import('./components/MathematicalSymbolsView').then((module) => {
    reportChunk('math-symbols');
    return { default: module.MathematicalSymbolsView };
  })
);

/**
 * The fallback for a loading surface.
 *
 * Deliberately the same background an empty pane gets, and deliberately not a
 * spinner: a pane that appears at its final size with nothing in it reads as
 * "still loading" for the few frames it lasts, where a spinner draws the eye to
 * something that is about to vanish.
 *
 * What it does carry is a *shape*: a few skeleton lines at the width and rhythm
 * of the text that is coming, plus the label underneath. On a fast launch those
 * lines are on screen for one or two frames and read as the pane arriving; on a
 * slow one they say the pane is coming and roughly what will be in it, which a
 * single centred word does not.
 *
 * The lines are `aria-hidden` — they are decoration standing in for content
 * nobody has yet — while the label is the status a screen reader should hear.
 */
export const PaneLoading: React.FC<{ label?: string }> = ({ label }) => (
  <div style={loadingPane} data-testid="pane-loading" aria-busy="true">
    <img src={waitingIconUrl} width={48} height={48} alt="" aria-hidden="true" />
    <div className="eu-pane-skeleton" aria-hidden="true">
      <span className="eu-skeleton" style={{ width: '52%' }} />
      <span className="eu-skeleton" style={{ width: '78%' }} />
      <span className="eu-skeleton" style={{ width: '64%' }} />
    </div>
    <span style={loadingLabel} role="status">{label ?? 'Loading…'}</span>
  </div>
);

const loadingPane: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 18,
  background: 'var(--eu-editor-bg)',
  color: 'var(--eu-fg-muted)',
  fontSize: 12
};

const loadingLabel: React.CSSProperties = { opacity: 0.7 };

/** Wraps one lazy surface in the boundary that draws its frame while it loads. */
export const Deferred: React.FC<{ label?: string; children: React.ReactNode }> = ({ label, children }) => (
  <Suspense fallback={<PaneLoading label={label} />}>{children}</Suspense>
);
