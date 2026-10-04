import React, { useEffect, useRef, useState } from 'react';
import type { ProjectLibraryStatus } from '../../../shared/projectLibrary';
import { dismissBootScreen } from '../../core/bootScreen';
import { useAppState } from '../state';
import { welcomeIconUrl } from '../appIcons';
import { Modal } from './Modal';
import {
  Folder,
  FolderOpen,
  FolderPlus,
  FileText,
  Settings,
  Library,
  ArrowRight,
} from './icons';
import './project-library.css';

export const showProjectLibrary = (mode: 'library' | 'create' = 'library') =>
  window.dispatchEvent(
    new CustomEvent('eukolia:project-library', { detail: mode }),
  );

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Do not mount services or restore documents until user-owned files have a location. */
export function ProjectLibraryGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<ProjectLibraryStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (!window.eukoliaApi?.getProjectLibrary) {
      setStatus({ configuredRoot: null, root: 'test-library', templates: [], inputs: [], hasMacros: false, projects: [] });
      return;
    }
    window.eukoliaApi
      .getProjectLibrary()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((reason) => {
        if (active) setError(message(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if ((status && !status.root) || error) dismissBootScreen();
  }, [status, error]);
  if (status?.root) return <>{children}</>;
  if (!status && !error) return null;
  const choose = async () => {
    setBusy(true);
    setError('');
    try {
      const selected = await window.eukoliaApi.chooseProjectLibrary();
      if (selected) setStatus(selected);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="library-setup">
      <header className="library-window-bar">Eukolia</header>
      <main className="library-welcome">
        <div className="library-emblem">
          <img src={welcomeIconUrl} width={40} height={40} alt="" aria-hidden="true" />
        </div>
        {/* The eyebrow above the headline and the headline itself are the same
            two lines they always were; what changed is that the eyebrow is now
            the wordmark's own line as well, drawn with the shell's `.eu-eyebrow`
            so it is the same all-caps micro-label every panel uses. */}
        <p className="library-eyebrow eu-eyebrow">YOUR WORK, IN ONE PLACE</p>
        <h1>A home for your ideas.</h1>
        <p className="library-lead">
          Choose a project library to keep your mathematics, writing, and shared
          tools together.
        </p>
        <div className="library-benefits">
          <div>
            <Folder size={20} />
            <span>
              <strong>Your projects</strong>
              <small>One folder for each paper, book, or set of notes.</small>
            </span>
          </div>
          <div>
            <FileText size={20} />
            <span>
              <strong>Your starting point</strong>
              <small>Reusable templates, macros, and input files.</small>
            </span>
          </div>
          <div>
            <Settings size={20} />
            <span>
              <strong>Your workspace</strong>
              <small>Snippets and preferences travel with your library.</small>
            </span>
          </div>
        </div>
        {(error || status?.error) && (
          <div role="alert" className="library-error">
            {error || status?.error}
            <p>Reconnect the library drive or choose a folder below.</p>
          </div>
        )}
        {/* The one thing this screen is for, so it is the one filled button on
            it: `.eu-btn` + `.eu-btn-primary` from the design system, with the
            `library-primary` class its stylesheet and this screen's own layout
            still key off. */}
        <button
          className="library-primary eu-btn eu-btn-primary"
          disabled={busy}
          onClick={() => void choose()}
        >
          <FolderOpen size={18} />
          {busy ? 'Preparing library…' : 'Choose or create a folder'}
          <ArrowRight size={17} />
        </button>
        <p className="library-note">
          Choose an existing folder or create one in the folder picker. Your
          current settings and snippets are copied; existing files are
          preserved.
        </p>
        {status?.configuredRoot && (
          <p className="library-path">
            Previous location: {status.configuredRoot}
          </p>
        )}
      </main>
    </div>
  );
}

export function LibraryHome() {
  const state = useAppState();
  return (
    <main className="library-home">
      <div className="library-emblem">
        <img src={welcomeIconUrl} width={40} height={40} alt="" aria-hidden="true" />
      </div>
      <h1>Space to think.</h1>
      <p className="library-lead">
        Start with a template, or return to your work.
      </p>
      <div className="library-actions">
        <button
          className="library-primary eu-btn eu-btn-primary"
          onClick={() => showProjectLibrary('create')}
        >
          <FolderPlus size={18} />
          New project
        </button>
        <button
          className="library-secondary eu-btn eu-btn-secondary"
          onClick={() => showProjectLibrary()}
        >
          <Library size={18} />
          Browse library
        </button>
      </div>
      <div className="library-secondary-actions">
        <button
          className="library-quiet eu-btn eu-btn-quiet"
          onClick={() => void state.openFolder()}
        >
          Open another folder
        </button>
        <button
          className="library-quiet eu-btn eu-btn-quiet"
          onClick={() => void state.openFile()}
        >
          Open a file
        </button>
      </div>
      <section className="library-recent">
        <h2 className="eu-eyebrow">Recent projects</h2>
        {state.recentWorkspaces.length ? (
          // A responsive grid rather than a stack: the window can be any width,
          // and a column of full-bleed rows at 1400px would be one long line of
          // text with a lot of nothing beside it.
          <div className="library-recent-grid">
            {state.recentWorkspaces.slice(0, 6).map((project) => (
              <button
                key={project.path}
                title={project.path}
                onClick={() => void state.openFolder(project.path)}
                className="library-recent-card eu-card eu-card-interactive"
              >
                <Folder size={18} />
                <span>
                  <strong>{project.name}</strong>
                  {/* The card's second line is the path, as it always was: two
                      projects called `paper` are told apart by where they live,
                      and the title attribute above carries the full path for the
                      case where the line is clipped. */}
                  <small className="eu-mono">{project.path}</small>
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <p className="library-empty eu-empty">
            Your recently opened projects will appear here.
          </p>
        )}
      </section>
    </main>
  );
}

export function LibrarySidebarButton() {
  const [root, setRoot] = useState('');
  useEffect(() => {
    window.eukoliaApi?.getProjectLibrary?.()
      ?.then((status) => setRoot(status.root ?? ''))
      ?.catch(() => undefined);
  }, []);
  return (
    <button
      className="library-switch eu-pressable"
      title={root || 'Project library'}
      onClick={() => showProjectLibrary()}
    >
      <Library size={17} />
      <span>
        <small>PROJECT LIBRARY</small>
        <strong>{root.split(/[\\/]/).pop() || 'Your projects'}</strong>
      </span>
      <FolderOpen size={16} />
    </button>
  );
}

export function ProjectLibraryDialog() {
  const state = useAppState();
  const [mode, setMode] = useState<'library' | 'create' | null>(null);
  const [status, setStatus] = useState<ProjectLibraryStatus | null>(null);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [copyMacros, setCopyMacros] = useState(true);
  const [inputs, setInputs] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    directory: string;
    mainFile: string;
  } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === 'create' && status) nameInput.current?.focus();
  }, [mode, status]);
  useEffect(() => {
    const open = (event: Event) => {
      if (busy) return;
      setMode(
        (event as CustomEvent).detail === 'create' ? 'create' : 'library',
      );
      setError('');
      setName('');
      setInputs([]);
      setCreated(null);
      setStatus(null);
      window.eukoliaApi
        .getProjectLibrary()
        .then((value) => {
          setStatus(value);
          setTemplate(value.templates[0] ?? '');
          setCopyMacros(value.hasMacros);
        })
        .catch((reason) => setError(message(reason)));
    };
    window.addEventListener('eukolia:project-library', open);
    return () => window.removeEventListener('eukolia:project-library', open);
  }, [busy]);
  const openShared = () => {
    void window.eukoliaApi
      .openLibrarySettings()
      .catch((reason) => setError(message(reason)));
  };
  const refresh = () => {
    void window.eukoliaApi
      .getProjectLibrary()
      .then((value) => {
        setStatus(value);
        if (!value.templates.includes(template))
          setTemplate(value.templates[0] ?? '');
        if (!value.hasMacros) setCopyMacros(false);
        setInputs((current) =>
          current.filter((input) => value.inputs.includes(input)),
        );
      })
      .catch((reason) => setError(message(reason)));
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result =
        created ??
        (await window.eukoliaApi.createLibraryProject({
          name: name.trim(),
          template,
          copyMacros,
          inputs,
        }));
      setCreated(result);
      await state.openFolder(result.directory);
      await state.openFile(result.mainFile);
      setMode(null);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={mode !== null}
      onClose={() => {
        if (!busy) setMode(null);
      }}
      title={mode === 'create' ? 'New project' : 'Project library'}
      width={680}
    >
      <div className="library-dialog">
        <div className="library-dialog-toolbar">
          <p className="library-path">
            {status?.root || 'Loading your library…'}
          </p>
          <button
            className="library-quiet eu-btn eu-btn-quiet"
            onClick={openShared}
            title="Open shared settings, templates and inputs"
          >
            <Settings size={16} />
            Shared files
          </button>
          <button className="library-quiet eu-btn eu-btn-quiet" onClick={refresh}>
            Refresh
          </button>
        </div>
        {(error || status?.error) && (
          <p role="alert" className="library-error">
            {error || status?.error}
          </p>
        )}
        {mode === 'library' ? (
          <>
            <div className="library-actions">
              <input
                className="eu-input eu-search-input"
                aria-label="Find a project"
                placeholder="Find a project…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <button
                className="library-primary eu-btn eu-btn-primary"
                onClick={() => setMode('create')}
              >
                <FolderPlus size={16} />
                New project
              </button>
            </div>
            <div className="library-projects">
              {status?.projects
                .filter((project) =>
                  project.name.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((project) => (
                  <button
                    key={project.path}
                    className="library-project eu-card eu-card-interactive"
                    onClick={() => {
                      void state.openFolder(project.path);
                      setMode(null);
                    }}
                  >
                    <Folder size={20} />
                    <span>{project.name}</span>
                    <ArrowRight size={16} />
                  </button>
                ))}
              {status && !status.projects.length && (
                <p className="library-empty eu-empty">
                  No projects yet. Create your first project from a template.
                </p>
              )}
              {status &&
                status.projects.length > 0 &&
                !status.projects.some((project) =>
                  project.name.toLowerCase().includes(filter.toLowerCase()),
                ) && <p className="library-empty eu-empty">No projects match “{filter}”.</p>}
            </div>
            <button
              className="library-quiet eu-btn eu-btn-quiet"
              onClick={() => {
                setMode(null);
                void state.openFolder();
              }}
            >
              Open a folder outside this library…
            </button>
          </>
        ) : (
          <form onSubmit={(event) => void create(event)}>
            <fieldset disabled={busy || !!created}>
              <label>
                Project name
                <input
                  className="eu-input"
                  ref={nameInput}
                  autoFocus
                  required
                  maxLength={100}
                  placeholder="e.g. Algebraic topology"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Template
                <select
                  className="eu-input"
                  required
                  value={template}
                  onChange={(event) => setTemplate(event.target.value)}
                >
                  {status?.templates.map((file) => (
                    <option key={file} value={file}>
                      {file.replace(/\.tex$/i, '')}
                    </option>
                  ))}
                </select>
              </label>
              {status && !status.templates.length && (
                <p className="library-empty eu-empty">
                  Add a .tex template to Shared files → templates, then refresh.
                </p>
              )}
              <div className="library-inputs">
                <h3 className="eu-eyebrow">Include in this project</h3>
                <label className="library-check">
                  <input
                    type="checkbox"
                    checked={copyMacros}
                    disabled={!status?.hasMacros}
                    onChange={(event) => setCopyMacros(event.target.checked)}
                  />
                  <span>
                    Copy shared macros<small>macros.tex</small>
                  </span>
                </label>
                {status?.inputs.map((file) => (
                  <label key={file} className="library-check">
                    <input
                      type="checkbox"
                      checked={inputs.includes(file)}
                      onChange={(event) =>
                        setInputs((current) =>
                          event.target.checked
                            ? [...current, file]
                            : current.filter((value) => value !== file),
                        )
                      }
                    />
                    <span>{file}</span>
                  </label>
                ))}
                {!status?.inputs.length && (
                  <p className="library-empty eu-empty">
                    Add reusable .tex files to Shared files → inputs to include
                    them here.
                  </p>
                )}
              </div>
              <p className="library-note">
                Selected files are copied into the project and included in its
                preamble. Later changes to shared files won’t change existing
                projects.
              </p>
              {name.trim() && (
                <div className="library-preview eu-card">
                  <small className="eu-eyebrow">NEW PROJECT</small>
                  <strong className="eu-mono">{name.trim()}/</strong>
                  <span className="eu-mono">{name.trim()}.tex</span>
                  {copyMacros && <span className="eu-mono">macros.tex</span>}
                  {inputs.map((file) => (
                    <span key={file} className="eu-mono">{file}</span>
                  ))}
                </div>
              )}
            </fieldset>
            <div className="library-form-footer">
              <button
                type="button"
                className="library-quiet eu-btn eu-btn-quiet"
                disabled={busy}
                onClick={() => {
                  setMode('library');
                  setCreated(null);
                  refresh();
                }}
              >
                Back to library
              </button>
              <button
                className="library-primary eu-btn eu-btn-primary"
                disabled={busy || !status?.root || !template || !name.trim()}
                type="submit"
              >
                {busy
                  ? 'Creating project…'
                  : created
                    ? 'Open created project'
                    : 'Create project'}
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
