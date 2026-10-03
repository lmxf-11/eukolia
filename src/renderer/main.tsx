/**
 * Eukolia — renderer entry point.
 *
 * Keeps the preload bridge's event streams wired into the app shell and mounts
 * React. All application logic lives in `ui/App.tsx` and the services it uses.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { commandRegistry } from './core/commands';
import { logRendererError } from './core/diagnostics';
import { installSmoothWheelScrolling } from './core/smoothScroll';
import { installStartupReport, startupMark } from './core/startupProbe';
import './index.css';
// The design system, loaded immediately after the global sheet it extends: the
// spacing scale, the elevation ladder, the motion vocabulary and the control
// primitives every panel composes from. See the file's own header for why the
// look was lifted out of the components and collected here.
import './ui/eukolia-design.css';
// The chrome the three shell strips are built from — title bar, tab strip,
// status bar — plus the activity bar and the workspace stage they sit around.
import './ui/eukolia-shell.css';
// The document face LaTeX itself uses. Vendored and imported first, because
// `--eu-serif-font` names it and the mathematics a widget draws was already set
// in it — without this the prose fell through to whatever serif the machine had.
import './latin-modern.css';
// The icon font the editor chrome draws its icons with. Vendored and
// imported here rather than with the editor, because the shell uses it too.
import './material-symbols.css';

/**
 * The first point the application's own code runs.
 *
 * Everything before it — fetching the bundle, parsing it, evaluating the whole
 * import graph above — is the cost of *what the entry point imports*, which is
 * exactly what the profiler's `renderer:entry` mark is measured against.
 */
startupMark('renderer:entry');
installStartupReport();

// One wheel handler for the whole shell: the same easing and the same duration
// over the editor, the lists, the panels, the terminal's frame and the tab
// manager, with the PDF viewer and xterm keeping their own. Installed before the
// first render so no notch is ever handled by two implementations.
installSmoothWheelScrolling();

// Menu items, the `eukolia://` protocol and the window-close hook all arrive as
// bridge events; forwarding them into the command registry keeps a single
// implementation behind every entry point.
if (window.eukoliaApi) {
  window.eukoliaApi.onMenuCommand((commandId) => {
    window.dispatchEvent(new CustomEvent('eukolia:menu-command', { detail: commandId }));
  });

  window.eukoliaApi.onBeforeClose(() => {
    void commandRegistry.execute('file.saveAll');
  });
}

window.addEventListener('error', (event) => logRendererError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => logRendererError(event.reason));

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Eukolia: #root element is missing from index.html');
}

startupMark('renderer:render-called');
const searchParams = new URLSearchParams(window.location.search);
const windowType = searchParams.get('window') || (window.location.hash ? window.location.hash.slice(1) : null);

let mainContent: React.ReactNode;
if (windowType === 'settings') {
  const StandaloneSettings = React.lazy(() => import('./ui/StandaloneSettingsWindow'));
  mainContent = (
    <React.Suspense fallback={null}>
      <StandaloneSettings />
    </React.Suspense>
  );
} else if (windowType === 'snippets') {
  const StandaloneSnippets = React.lazy(() => import('./ui/StandaloneSnippetsWindow'));
  mainContent = (
    <React.Suspense fallback={null}>
      <StandaloneSnippets />
    </React.Suspense>
  );
} else {
  const App = React.lazy(() => import('./ui/App'));
  const ProjectLibraryGate = React.lazy(() =>
    import('./ui/components/ProjectLibrary').then((m) => ({ default: m.ProjectLibraryGate }))
  );
  mainContent = (
    <React.Suspense fallback={null}>
      <ProjectLibraryGate>
        <App />
      </ProjectLibraryGate>
    </React.Suspense>
  );
}

ReactDOM.createRoot(rootElement, {
  onUncaughtError: (error) => {
    startupMark(`react:uncaught:${error instanceof Error ? error.message.slice(0, 60) : String(error).slice(0, 60)}`);
    logRendererError(error);
  },
  onCaughtError: (error) => {
    startupMark(`react:caught:${error instanceof Error ? error.message.slice(0, 60) : String(error).slice(0, 60)}`);
  },
  onRecoverableError: (error) => {
    startupMark(`react:recoverable:${error instanceof Error ? error.message.slice(0, 60) : String(error).slice(0, 60)}`);
  }
}).render(
  <React.StrictMode>
    {mainContent}
  </React.StrictMode>
);
startupMark('renderer:render-returned');
