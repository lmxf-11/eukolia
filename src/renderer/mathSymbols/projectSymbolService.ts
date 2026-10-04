/**
 * Eukolia — the live project context for the Mathematical Symbols panel.
 *
 * `projectSymbolContext.ts` is the pure half: it turns plain data into an
 * immutable snapshot. This is the half that has to know about the running
 * application — which project is open, which file the caret is in, when the
 * analysis has finished — and its whole job is to publish a *new snapshot* when,
 * and only when, one of those facts changes.
 *
 * ## What triggers a rebuild, and what must not
 *
 * `MathematicalSymbols.md` §10 is explicit: project analysis runs on source,
 * root and include changes — **not** on hover, pointer movement, editor scroll,
 * cursor movement or a selection-only transaction. So the subscriptions here are
 * the project index's `index-change`, its `root-document-change`, and the
 * workspace's `change`/`tree-change`/`root-document`. Nothing watches the
 * editor, and there is no cursor-driven path at all. The caret's *context* is
 * recomputed when the panel asks for it, from the editor state at that moment,
 * which costs a bounded tree query and cannot rebuild the catalog.
 *
 * ## Stale results
 *
 * The revision only ever increases, and `refresh()` reads the current facts
 * synchronously and publishes them under the next revision. There is no async
 * result to discard here for that reason: the include walk that feeds the index
 * is asynchronous, and it announces itself by emitting `index-change`, so the
 * snapshot is rebuilt *after* it lands rather than racing it. Switching roots
 * publishes an incomplete snapshot first — see `ProjectSymbolSnapshot.complete`
 * — so a panel that is already open stops claiming the previous project's
 * packages are loaded while the new project is being indexed.
 */

import { EventEmitter } from '../core/events'
import { projectIndex } from '../document/projectIndex'
import { setting } from '../core/settings'
import { parseContent } from '../vendor/latex-workshop/completion/package'
import { workspaceService } from '../services/instance'
import { buildProjectSymbolSnapshot, type ProjectSymbolSnapshotInput } from './projectSymbolContext'
import packageMetadata from './curated/packages.json'
import type { ProjectSymbolSnapshot } from './types'

/** The events a snapshot listener can be told about. */
export interface ProjectSymbolSnapshotEvent {
  readonly snapshot: ProjectSymbolSnapshot
  /** What caused the rebuild, for the panel's provenance line and for tests. */
  readonly cause:
    | 'initial'
    | 'index'
    | 'root'
    | 'workspace'
    | 'tree'
    | 'manual'
}

/**
 * What a loaded package also brings with it.
 *
 * `MathematicalSymbols.md` §6 asks for "known transitive capabilities in
 * reviewed metadata", and this is it: `amssymb` loads `amsfonts`, so a document
 * whose preamble is `\usepackage{amssymb}` can typeset `\mathbb` even though the
 * package list never says `amsfonts`. Without the closure the panel tells the
 * user that a working command is unavailable — measured in the built
 * application, on a fixture whose whole preamble was `amsmath, amssymb`.
 *
 * The edges are LaTeX Workshop's own, copied from the bundled
 * `data/latex-workshop/packages/*.json` `deps` arrays rather than read at
 * runtime: that data store is lazy, and the panel needs one synchronous answer.
 */
const TRANSITIVE: Readonly<Record<string, readonly string[]>> =
  packageMetadata.transitivePackages as unknown as Record<string, readonly string[]>

/**
 * A package set with its dependency closure.
 *
 * Iterated to a fixed point rather than one level deep, because the edges chain:
 * `empheq` → `mathtools` → `amsmath` → `amstext`. The visited set is what makes
 * a cyclic `deps` array terminate rather than spin.
 */
export function withTransitivePackages(names: Iterable<string>): string[] {
  const resolved = new Set<string>()
  const queue = [...names]
  while (queue.length > 0) {
    const name = queue.pop() as string
    const key = name.toLowerCase()
    if (resolved.has(key)) continue
    resolved.add(key)
    for (const dependency of TRANSITIVE[key] ?? []) {
      if (!resolved.has(dependency)) queue.push(dependency)
    }
  }
  return [...resolved].sort()
}

/**
 * The package names a set of source texts loads, with their dependencies.
 *
 * Deliberately the ported LaTeX Workshop rule (`parseContent`, the reference's
 * own `package.parseContent` plus the `\documentclass` branch) rather than a
 * fresh regular expression. It already handles comma-separated lists, optional
 * argument lists, `\RequirePackage` and the `class-<name>` naming the
 * dependency graph uses, and it is the same parse the completion providers run
 * over the same documents — so the panel and the completer cannot disagree
 * about what this project loads.
 */
export function packagesFromSources(sources: readonly string[]): string[] {
  const found = new Set<string>()
  for (const source of sources) {
    for (const name of Object.keys(parseContent(source))) {
      // `class-article` is how the dependency graph names a document class; the
      // class is not a package and a symbol requirement never names one.
      if (name.startsWith('class-')) continue
      found.add(name)
    }
  }
  return withTransitivePackages(found)
}

/**
 * The snapshot service.
 *
 * Constructed once by `projectSymbolService` at the foot of this file. Tests
 * construct their own with injected facts, which is why the subscriptions are
 * registered explicitly rather than in the constructor.
 */
export class ProjectSymbolService extends EventEmitter {
  private revision = 0
  private snapshot: ProjectSymbolSnapshot | null = null
  private disposers: Array<() => void> = []
  private running = false
  /**
   * Whether the current compilation root has been analysed.
   *
   * Starts true: the panel opens against whatever the index already holds, and
   * the analysis for the current root has usually been published before the
   * panel existed to hear about it.
   */
  private rootAnalysed = true
  /** The workspace root the last snapshot was built for, or `null` before any. */
  private lastWorkspaceRoot: string | null = null

  /** The workspace root the application is on now. */
  private workspaceRootNow(): string | null {
    return projectIndex.getProjectRoot() ?? workspaceService.getWorkspacePath() ?? null
  }

  /** The current snapshot, or `null` before the first refresh. */
  public getSnapshot(): ProjectSymbolSnapshot | null {
    return this.snapshot
  }

  /** The revision the next published snapshot will carry. */
  public getRevision(): number {
    return this.revision
  }

  public subscribe(listener: (event: ProjectSymbolSnapshotEvent) => void): () => void {
    return this.on('snapshot', listener as (payload: unknown) => void)
  }

  /**
   * Starts watching the application.
   *
   * Idempotent: a second call is a no-op, so a component that mounts twice
   * cannot double every event.
   */
  public start(): void {
    if (this.running) return
    this.running = true

    this.disposers.push(
      projectIndex.on('index-change', () => this.refresh('index')),
      projectIndex.on('root-document-change', () => this.refresh('root')),
      workspaceService.on('change', () => this.refresh('workspace')),
      workspaceService.on('tree-change', () => this.refresh('tree')),
      workspaceService.on('root-document', () => this.refresh('root'))
    )

    this.refresh('initial')
  }

  /** Stops watching. The last snapshot stays readable. */
  public stop(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.running = false
  }

  /**
   * Rebuilds the snapshot from the application's current state.
   *
   * `complete` is false whenever a compilation root is known but no analysis
   * has been published for it yet. That is the difference §6 asks the panel to
   * be able to see: while it is false, no *negative* claim about a package is
   * made, and core commands still work because their availability is a static
   * fact.
   */
  public refresh(cause: ProjectSymbolSnapshotEvent['cause'] = 'manual'): ProjectSymbolSnapshot {
    /*
     * Whether the current root has been analysed at all.
     *
     * The project index has no completion signal — it emits `index-change` and
     * says nothing about whether the include walk behind it has finished — so
     * this tracks the *announcement*: a root change clears it and the next
     * `index-change` sets it.
     *
     * It starts **true**, and that is not a detail. The panel is opened against
     * whatever the index already holds, and by then the analysis for the current
     * root has usually been published — before the panel existed to hear about
     * it. Starting false made an already-analysed project report "still
     * checking" for as long as the document sat idle, which in the built
     * application meant every symbol needing a package stayed un-insertable
     * until the user happened to edit something. Measured: the message never
     * moved off "still checking" in twenty-five seconds on a project whose
     * preamble names every package it needs.
     */
    if (cause === 'index') this.rootAnalysed = true
    if (cause === 'root') this.rootAnalysed = false

    /*
     * A different project is a different answer, and the previous project's
     * packages must not be claimed for it. `cause === 'initial'` is the first
     * look and trusts the index; every later change of workspace root does not.
     */
    const workspaceRoot = this.workspaceRootNow()
    if (this.lastWorkspaceRoot !== null && workspaceRoot !== this.lastWorkspaceRoot) {
      this.rootAnalysed = false
    }
    this.lastWorkspaceRoot = workspaceRoot

    this.revision += 1
    const input = this.readInput()
    const snapshot = buildProjectSymbolSnapshot(input, this.revision)
    this.snapshot = snapshot
    this.emit('snapshot', { snapshot, cause })
    return snapshot
  }

  /** Reads the application's current facts into the pure builder's input. */
  private readInput(): ProjectSymbolSnapshotInput {
    const workspaceRoot = projectIndex.getProjectRoot() ?? workspaceService.getWorkspacePath() ?? null
    const activeDocumentPath = workspaceService.getActiveDocument()?.uri ?? null
    const compilationRoot = projectIndex.getRootDocumentPath() ?? activeDocumentPath

    /*
     * The sources the compilation reaches, plus the open buffers.
     *
     * `getIncludedSourcePaths()` is the include walk's own list and is what
     * decides scope. The *texts* come from `getAllSources()`, which is the open
     * buffers plus every included file not shadowed by one — a package loaded
     * by any of them is loaded by the compilation.
     */
    const reachableSources = projectIndex.getIncludedSourcePaths()
    const sourceTexts = projectIndex.getAllSources()

    const macros = projectIndex.getMacros().map((macro) => ({
      name: macro.name,
      args: macro.args,
      file: macro.file ?? null,
      line: macro.line,
      definition: macro.definition
    }))

    const notes: string[] = []
    if (workspaceRoot === null) notes.push('no project is open; only core commands and this file are known')
    if (compilationRoot === null) notes.push('no compilation root was detected')
    if (reachableSources.length === 0 && compilationRoot !== null) {
      notes.push('the include walk has not reported any included files yet')
    }

    const engine = setting.str('compilation.engine')

    return {
      workspaceRoot,
      compilationRoot,
      activeDocumentPath,
      reachableSources,
      macros,
      packages: packagesFromSources(sourceTexts),
      engine: engine && engine.length > 0 ? engine : null,
      complete: this.analysisComplete(reachableSources.length),
      notes
    }
  }

  /**
   * Whether analysis has run for the current root.
   *
   * A project that includes no other files is complete by construction: there is
   * nothing the walk could still add. Anything else waits for the index to say
   * it has published.
   */
  private analysisComplete(includedCount: number): boolean {
    return this.rootAnalysed || includedCount === 0
  }
}

/**
 * The application's snapshot service.
 *
 * Started by the panel on mount rather than at import time: the panel is the
 * only consumer, and a service that subscribes to the project index on import
 * would do so in the settings and snippets windows too, where there is no
 * project at all.
 */
export const projectSymbolService = new ProjectSymbolService()
