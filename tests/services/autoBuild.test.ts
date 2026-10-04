/**
 * Automatic builds: the three modes, and the rules that keep a build from
 * chasing its own output.
 *
 * The modes are LaTeX Workshop's (`never`, `onSave`, `onFileChange`), and the
 * defect this file exists for was that Eukolia had the setting and not the
 * behaviour: `compilation.autoBuild` offered all three values while the shell
 * listened for a `saved` event the workspace service never emitted, so *none* of
 * them built anything — and `onFileChange`, which is about changes made on disk
 * by anything, was never distinguished from a save at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_BUILD_MODES,
  AUTO_BUILD_MODE_DESCRIPTIONS,
  AutoBuildScheduler,
  decideAutoBuild,
  isBuildArtefact,
  isIgnored,
  isProjectFile,
  isSourceDocument,
  matchesIgnorePattern
} from '../../src/renderer/services/autoBuild';

const ROOT = 'D:/papers/paper/main.tex';
const IGNORE = ['**/*.sty', '**/*.cls'];

function decide(overrides: Partial<Parameters<typeof decideAutoBuild>[0]> = {}) {
  return decideAutoBuild({
    mode: 'onFileChange',
    trigger: 'external-change',
    path: 'D:/papers/paper/chapter.tex',
    rootFile: ROOT,
    ignore: IGNORE,
    ...overrides
  });
}

describe('the three modes', () => {
  it('offers exactly the reference values, in the reference order, with a line each', () => {
    expect(AUTO_BUILD_MODES).toEqual(['never', 'onSave', 'onFileChange']);
    expect(AUTO_BUILD_MODE_DESCRIPTIONS).toHaveLength(AUTO_BUILD_MODES.length);
  });

  it('builds nothing at all when the mode is never', () => {
    for (const trigger of ['save', 'external-change'] as const) {
      expect(decide({ mode: 'never', trigger }).reason).toBe('mode-never');
    }
  });

  it('builds on a save in both automatic modes', () => {
    for (const mode of ['onSave', 'onFileChange'] as const) {
      expect(decide({ mode, trigger: 'save', path: ROOT })).toEqual({ build: true, reason: 'ok' });
    }
  });

  it('treats a change on disk as a build only in onFileChange — onSave is the stricter one', () => {
    expect(decide({ mode: 'onFileChange', trigger: 'external-change', path: ROOT }).build).toBe(true);
    expect(decide({ mode: 'onSave', trigger: 'external-change', path: ROOT })).toEqual({
      build: false,
      reason: 'mode-on-save-does-not-watch-disk'
    });
  });

  it('builds for a change made by another application', () => {
    // The point of `onFileChange`: a file written by anything at all, not only by
    // this editor's save command.
    expect(decide({ mode: 'onFileChange', trigger: 'external-change', path: 'D:/papers/paper/refs.bib' }).build).toBe(true);
  });
});

describe('what a trigger has to be', () => {
  it('refuses to build with no root document', () => {
    expect(decide({ rootFile: null }).reason).toBe('no-root-document');
  });

  it('never builds because of the build\u2019s own output', () => {
    // Otherwise a build triggers itself: compile, watch the .aux land, compile.
    for (const extension of ['pdf', 'aux', 'log', 'fls', 'fdb_latexmk', 'synctex.gz', 'xdv', 'dvi', 'bcf', 'run.xml']) {
      const path = `D:/papers/paper/main.${extension}`;
      expect(decide({ mode: 'onFileChange', trigger: 'external-change', path }), path).toEqual({
        build: false,
        reason: 'build-artefact'
      });
      // …and it is an artefact for a *save* of it too.
      expect(decide({ mode: 'onSave', trigger: 'save', path }).build, path).toBe(false);
    }
  });

  it('does not mistake a figure for the build\u2019s output', () => {
    // `figure.pdf` is an asset the document reads; `main.pdf` is what latexmk
    // wrote. The job name is what tells them apart.
    expect(isBuildArtefact('D:/papers/paper/figure.pdf', ROOT)).toBe(false);
    expect(isBuildArtefact('D:/papers/paper/main.pdf', ROOT)).toBe(true);
    expect(decide({ mode: 'onFileChange', trigger: 'external-change', path: 'D:/papers/paper/figure.pdf' }).build).toBe(true);
  });

  it('recognises an artefact by the root document\u2019s job name, not by extension alone', () => {
    expect(isBuildArtefact('D:/papers/paper/main.aux', ROOT)).toBe(true);
    expect(isBuildArtefact('D:/papers/paper/other.aux', ROOT)).toBe(false);
    expect(isBuildArtefact('D:/papers/main.tex', ROOT)).toBe(false);
    // A build that writes elsewhere keeps the same job name.
    expect(isBuildArtefact('D:/papers/paper/build/main.pdf', ROOT)).toBe(true);
    expect(isBuildArtefact('D:/papers/paper/main.aux', null)).toBe(false);
  });

  it('honours the ignore list', () => {
    expect(isIgnored('D:/papers/paper/foo.sty', IGNORE)).toBe(true);
    expect(isIgnored('D:/papers/paper/sub/dir/foo.cls', IGNORE)).toBe(true);
    expect(isIgnored('D:/papers/paper/chapter.tex', IGNORE)).toBe(false);
    expect(matchesIgnorePattern('D:/papers/paper/chapter.tex', '*.tex')).toBe(true);
    expect(matchesIgnorePattern('D:/papers/paper/chapter.tex', 'D:/papers/paper/chapter.tex')).toBe(true);
    expect(matchesIgnorePattern('D:/papers/paper/chapter.tex', '')).toBe(false);
    expect(decide({ path: 'D:/papers/paper/foo.sty' }).reason).toBe('ignored');
  });

  it('treats only files TeX can read as project files', () => {
    for (const path of ['a.tex', 'a.ltx', 'a.bib', 'a.sty', 'a.cls', 'a.def', 'a.tikz', 'a.png', 'a.eps', 'a.svg', 'a.csv']) {
      expect(isProjectFile(path), path).toBe(true);
    }
    for (const path of ['a.json', 'a.md', 'a.txt2', 'notes']) {
      expect(isProjectFile(path), path).toBe(false);
    }
    // …and a *save* has to be a LaTeX document: saving the bibliography is not a
    // reason to compile, saving the chapter is.
    expect(isSourceDocument('a.tex')).toBe(true);
    expect(isSourceDocument('a.bib')).toBe(false);
    expect(decide({ trigger: 'save', path: 'D:/papers/paper/refs.bib' }).reason).toBe('not-a-source-file');
    expect(decide({ trigger: 'save', path: 'D:/papers/paper/chapter.tex' }).build).toBe(true);
  });
});

describe('the scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function scheduler(overrides: Partial<ConstructorParameters<typeof AutoBuildScheduler>[0]> = {}) {
    const builds: string[] = [];
    let running = false;
    let lastStart: number | null = null;
    const decisions: string[] = [];
    const instance = new AutoBuildScheduler({
      build: () => {
        builds.push(`build@${Date.now()}`);
        running = false;
        lastStart = Date.now();
      },
      isRunning: () => running,
      delayMs: () => 800,
      minIntervalMs: () => 1000,
      lastBuildStartedAt: () => lastStart,
      onDecision: (decision) => decisions.push(`${decision.trigger}:${decision.reason}`),
      ...overrides
    });
    return {
      instance,
      builds,
      decisions,
      setRunning: (value: boolean) => {
        running = value;
      },
      setLastStart: (value: number | null) => {
        lastStart = value;
      }
    };
  }

  it('collects a burst of triggers into one build', () => {
    const harness = scheduler();
    const context = { mode: 'onFileChange', rootFile: ROOT, ignore: IGNORE };
    harness.instance.request('save', ROOT, context);
    vi.advanceTimersByTime(300);
    harness.instance.request('external-change', 'D:/papers/paper/chapter.tex', context);
    vi.advanceTimersByTime(300);
    harness.instance.request('external-change', 'D:/papers/paper/refs.bib', context);
    expect(harness.builds).toHaveLength(0);

    vi.advanceTimersByTime(800);
    expect(harness.builds).toHaveLength(1);
    harness.instance.dispose();
  });

  it('waits for a running build instead of starting a second one', () => {
    const harness = scheduler();
    harness.setRunning(true);
    harness.instance.request('save', ROOT, { mode: 'onSave', rootFile: ROOT, ignore: IGNORE });
    vi.advanceTimersByTime(800);
    expect(harness.builds).toHaveLength(0);
    expect(harness.instance.isPending()).toBe(true);

    // Still running: no build.
    vi.advanceTimersByTime(1000);
    expect(harness.builds).toHaveLength(0);

    harness.setRunning(false);
    vi.advanceTimersByTime(250);
    expect(harness.builds).toHaveLength(1);
    harness.instance.dispose();
  });

  it('leaves the minimum interval after the last build, manual or automatic', () => {
    const harness = scheduler();
    // A build — manual or not — started 200 ms ago: 800 ms of the interval are
    // left, and the debounce window has already passed at 800 ms.
    harness.setLastStart(Date.now() - 200);
    harness.instance.request('save', ROOT, { mode: 'onSave', rootFile: ROOT, ignore: IGNORE });
    vi.advanceTimersByTime(700);
    expect(harness.builds).toHaveLength(0);

    vi.advanceTimersByTime(200);
    expect(harness.builds).toHaveLength(1);
    harness.instance.dispose();
  });

  it('reports every decision, including the ones that build nothing', () => {
    const harness = scheduler();
    harness.instance.request('external-change', ROOT, { mode: 'onSave', rootFile: ROOT, ignore: IGNORE });
    harness.instance.request('external-change', 'D:/papers/paper/main.aux', { mode: 'onFileChange', rootFile: ROOT, ignore: IGNORE });
    harness.instance.request('save', ROOT, { mode: 'never', rootFile: ROOT, ignore: IGNORE });
    vi.advanceTimersByTime(2000);
    expect(harness.decisions).toEqual([
      'external-change:mode-on-save-does-not-watch-disk',
      'external-change:build-artefact',
      'save:mode-never'
    ]);
    expect(harness.builds).toHaveLength(0);
    harness.instance.dispose();
  });

  it('stops building once it is disposed', () => {
    const harness = scheduler();
    harness.instance.request('save', ROOT, { mode: 'onSave', rootFile: ROOT, ignore: IGNORE });
    harness.instance.dispose();
    vi.advanceTimersByTime(5000);
    expect(harness.builds).toHaveLength(0);
    expect(harness.instance.isPending()).toBe(false);
  });
});
