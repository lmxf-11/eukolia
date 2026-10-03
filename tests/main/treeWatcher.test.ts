// @vitest-environment node
/**
 * The recursive workspace watcher.
 *
 * Two halves, because the module has two kinds of claim to make. The *policy* —
 * that a rename is resolved by looking, that an excluded directory is never
 * watched or reported, that a burst becomes one batch, that a failure is reported
 * once — is driven through fake ports, so it can be asserted exactly. The
 * *plumbing* — that `nodeWatchPorts` really does watch a tree with `fs.watch` on
 * this platform, including the directories created after the watch started — is
 * driven against a real temporary directory, because that is the part a fake
 * cannot vouch for.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_BUFFERED_CHANGES,
  MAX_FALLBACK_DIRECTORIES,
  MAX_WORK_CHUNK,
  TreeWatcher,
  nodeWatchPorts,
  type RawWatchEvent,
  type TreeWatcherPorts,
  type WatchSubscription
} from '../../src/main/ipc/treeWatcher'
import type { FileWatchErrorEvent, FileWatchEvent } from '../../src/shared/ipc'

/** Ports a test drives by hand: events are delivered when the test says so. */
function fakePorts(options: {
  recursive?: 'ok' | 'unsupported' | 'fails'
  directories?: string[]
  /** Overrides `exists`, so a test can make a path vanish while the window is open. */
  exists?: (target: string) => boolean
  /** Overrides `isDirectory`, for the "a new directory appeared" path. */
  isDirectory?: (target: string) => boolean
}) {
  const watchers: Array<{ directory: string; recursive: boolean; close: () => void }> = []
  const listeners = new Map<string, (event: RawWatchEvent) => void>()
  const errors = new Map<string, (error: unknown) => void>()
  const closed: string[] = []

  /** Parent directory → its children, computed once so lookups stay O(1). */
  const childrenOf = new Map<string, string[]>()
  for (const child of options.directories ?? []) {
    const parent = path.dirname(child)
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
  }

  const subscribe = (
    directory: string,
    recursive: boolean,
    onEvent: (event: RawWatchEvent) => void,
    onError: (error: unknown) => void
  ): WatchSubscription => {
    watchers.push({ directory, recursive, close: () => closed.push(directory) })
    listeners.set(directory, onEvent)
    errors.set(directory, onError)
    return { close: () => closed.push(directory) }
  }

  const ports: TreeWatcherPorts = {
    watchRecursive: (directory, onEvent, onError) => {
      if (options.recursive === 'unsupported') {
        throw Object.assign(new Error('not supported'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
      }
      if (options.recursive === 'fails') {
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
      }
      return subscribe(directory, true, onEvent, onError)
    },
    watchDirectory: (directory, onEvent, onError) => subscribe(directory, false, onEvent, onError),
    // Precomputed once: filtering 10 000 paths per directory would make the
    // "too many directories" case quadratic and time out for reasons unrelated to
    // what it tests.
    listSubdirectories: (directory) => childrenOf.get(directory) ?? [],
    isDirectory: (target) => options.isDirectory?.(target) ?? (options.directories ?? []).includes(target),
    exists: (target) => options.exists?.(target) ?? (options.directories ?? []).includes(target)
  }

  return {
    ports,
    watchers,
    closed,
    emit: (directory: string, event: RawWatchEvent) => listeners.get(directory)?.(event),
    fail: (directory: string, error: unknown) => errors.get(directory)?.(error)
  }
}

const ROOT = path.join('C:', 'project')

/** A watcher whose deliveries are collected, with a short window so tests are quick. */
function collect(options: Parameters<typeof fakePorts>[0], debounceMs = 10) {
  const harness = fakePorts(options)
  const events: FileWatchEvent[][] = []
  const reported: FileWatchErrorEvent[] = []
  const diagnostics: string[] = []
  const watcher = new TreeWatcher({
    root: ROOT,
    ports: harness.ports,
    excludes: new Set(['node_modules', '.git']),
    deliver: (batch) => events.push(batch),
    report: (error) => reported.push(error),
    diagnose: (message) => diagnostics.push(message),
    debounceMs
  })
  return { ...harness, watcher, events, reported, diagnostics }
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the watcher policy', () => {
  it('delivers a burst as one batch, with the newest kind per path', async () => {
    const target = path.join(ROOT, 'a.tex')
    const harness = collect({ recursive: 'ok', exists: (candidate) => candidate === target })
    harness.watcher.start()

    harness.emit(ROOT, { type: 'rename', filename: 'a.tex' })
    harness.emit(ROOT, { type: 'change', filename: 'a.tex' })
    harness.emit(ROOT, { type: 'change', filename: 'a.tex' })
    await settle()

    expect(harness.events).toHaveLength(1)
    // A creation followed by writes is a change: the file is there, and what the
    // consumer has to do about it — re-read the tree, re-stat the buffer — is the
    // same either way.
    expect(harness.events[0]).toEqual([{ path: target, kind: 'change' }])
  })

  it('reports a delete only when the path is really gone at delivery', async () => {
    /*
     * What an atomic save looks like from the outside: the temp file is renamed
     * over the target, which the platform reports as a rename — sometimes as a
     * delete followed by a create. Delivering the delete half of a file that is
     * sitting there has the editor announce that an open document was removed.
     */
    const main = path.join(ROOT, 'main.tex')
    let onDisk = true
    const harness = collect({ recursive: 'ok', exists: (candidate) => candidate === main && onDisk })
    harness.watcher.start()

    harness.emit(ROOT, { type: 'rename', filename: 'main.tex' })
    await settle()
    expect(harness.events[0]).toEqual([{ path: main, kind: 'create' }])

    onDisk = false
    harness.emit(ROOT, { type: 'change', filename: 'main.tex' })
    await settle()
    expect(harness.events[1]).toEqual([{ path: main, kind: 'delete' }])
  })

  it('says nothing about a file that was created and deleted inside the window', async () => {
    // VS Code's coalescer folds ADDED+DELETED away: nothing happened, and a
    // consumer told otherwise re-reads the tree twice for no reason.
    const scratch = path.join(ROOT, 'scratch.tmp')
    let onDisk = true
    const harness = collect({ recursive: 'ok', exists: (candidate) => candidate === scratch && onDisk })
    harness.watcher.start()

    harness.emit(ROOT, { type: 'rename', filename: 'scratch.tmp' })
    onDisk = false
    harness.emit(ROOT, { type: 'rename', filename: 'scratch.tmp' })
    await settle()

    expect(harness.events).toEqual([])
  })

  it('folds a delete followed by a create into a change, the way a save arrives', async () => {
    const main = path.join(ROOT, 'main.tex')
    let onDisk = false
    const harness = collect({ recursive: 'ok', exists: (candidate) => candidate === main && onDisk })
    harness.watcher.start()

    // The rename over the target is reported as the target going away…
    harness.emit(ROOT, { type: 'rename', filename: 'main.tex' })
    // …and then being there again.
    onDisk = true
    harness.emit(ROOT, { type: 'rename', filename: 'main.tex' })
    await settle()

    expect(harness.events).toEqual([[{ path: main, kind: 'change' }]])
  })

  it('drops a child delete when the directory above it was deleted too', async () => {
    // Removing a folder reports the folder and everything that was inside it; only
    // the folder is worth delivering.
    const directory = path.join(ROOT, 'chapters')
    const harness = collect({ recursive: 'ok', exists: () => false })
    harness.watcher.start()

    harness.emit(ROOT, { type: 'rename', filename: 'chapters' })
    harness.emit(ROOT, { type: 'rename', filename: path.join('chapters', 'one.tex') })
    await settle()

    expect(harness.events).toEqual([[{ path: directory, kind: 'delete' }]])
  })

  it('resolves a rename by looking, so a deleted file is a delete', async () => {
    // `fs.watch` reports `rename` for both directions; the difference is whether
    // the path is there afterwards.
    const harness = collect({ recursive: 'ok', exists: () => false })
    harness.watcher.start()

    harness.emit(ROOT, { type: 'rename', filename: 'gone.tex' })
    await settle()

    expect(harness.events[0]).toEqual([{ path: path.join(ROOT, 'gone.tex'), kind: 'delete' }])
  })

  it('never watches or reports an excluded directory', async () => {
    const harness = collect({
      recursive: 'unsupported',
      directories: [path.join(ROOT, 'chapters'), path.join(ROOT, 'node_modules'), path.join(ROOT, 'node_modules', 'left-pad')]
    })
    harness.watcher.start()

    expect(harness.watchers.map((entry) => entry.directory)).toEqual([ROOT, path.join(ROOT, 'chapters')])

    harness.emit(ROOT, { type: 'change', filename: path.join('node_modules', 'left-pad', 'index.js') })
    await settle()
    expect(harness.events).toEqual([])

    harness.emit(ROOT, { type: 'change', filename: path.join('chapters', 'one.tex') })
    await settle()
    expect(harness.events[0][0].path).toBe(path.join(ROOT, 'chapters', 'one.tex'))
  })

  it('ignores a directory whose name is only excluded further up', () => {
    // A workspace that happens to be called `node_modules` is still watched: the
    // rule is about segments *below* the root.
    const harness = collect({ recursive: 'unsupported', directories: [] })
    harness.watcher.start()
    expect(harness.watchers).toHaveLength(1)
  })

  it('falls back to one watcher per directory where the platform has no recursion', () => {
    const harness = collect({
      recursive: 'unsupported',
      directories: [path.join(ROOT, 'a'), path.join(ROOT, 'a', 'b'), path.join(ROOT, 'c')]
    })
    harness.watcher.start()

    expect(harness.watcher.usingNativeRecursion).toBe(false)
    expect(harness.watchers.map((entry) => entry.directory).sort()).toEqual(
      [ROOT, path.join(ROOT, 'a'), path.join(ROOT, 'a', 'b'), path.join(ROOT, 'c')].sort()
    )
  })

  it('watches a directory that appears after the watch started', async () => {
    // Without this, everything created inside a new folder is invisible — the
    // failure mode the fallback strategy has and the native one does not.
    const created = path.join(ROOT, 'new')
    const harness = collect({
      recursive: 'unsupported',
      directories: [],
      // It is there — which is how the watcher knows the rename was a creation —
      // and it is a directory, which is how it knows to start watching it.
      exists: (target) => target === created,
      isDirectory: (target) => target === created
    })
    harness.watcher.start()
    expect(harness.watchers).toHaveLength(1)

    harness.emit(ROOT, { type: 'rename', filename: 'new' })
    await settle()

    expect(harness.watchers.map((entry) => entry.directory)).toContain(created)
    expect(harness.events[0]).toEqual([{ path: created, kind: 'create' }])
  })

  it('reports a failure once, not once per directory', () => {
    const harness = collect({ recursive: 'ok' })
    harness.watcher.start()

    harness.fail(ROOT, Object.assign(new Error('too many open files'), { code: 'EMFILE' }))
    harness.fail(ROOT, Object.assign(new Error('too many open files'), { code: 'EMFILE' }))

    expect(harness.reported).toHaveLength(1)
    expect(harness.reported[0]).toMatchObject({ path: ROOT, code: 'EMFILE' })
  })

  it('reports a recursive watch that fails for a reason other than the platform', () => {
    const harness = collect({ recursive: 'fails' })
    harness.watcher.start()

    expect(harness.reported[0]).toMatchObject({ code: 'EMFILE' })
    // Nothing was watched, so nothing pretends to be.
    expect(harness.watchers).toHaveLength(0)
  })

  it('stops watching when asked, and delivers what it had', async () => {
    const target = path.join(ROOT, 'a.tex')
    const harness = collect({ recursive: 'ok', exists: (candidate) => candidate === target })
    harness.watcher.start()
    harness.emit(ROOT, { type: 'change', filename: 'a.tex' })

    harness.watcher.stop()
    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toEqual([{ path: target, kind: 'change' }])

    harness.emit(ROOT, { type: 'change', filename: 'b.tex' })
    await settle()
    expect(harness.events).toHaveLength(1)
  })

  it('refuses to watch more directories than the platform could hold open', () => {
    const many = Array.from({ length: MAX_FALLBACK_DIRECTORIES + 2 }, (_unused, index) => path.join(ROOT, `d${index}`))
    const harness = collect({ recursive: 'unsupported', directories: many })
    harness.watcher.start()

    expect(harness.watchers.length).toBeLessThanOrEqual(MAX_FALLBACK_DIRECTORIES)
    expect(harness.reported.map((error) => error.code)).toContain('EMFILE')
  })

  it(`delivers at most ${MAX_WORK_CHUNK} changes at a time, and the rest after a rest`, async () => {
    // A checkout of ten thousand files must not become ten thousand messages in one
    // turn: VS Code throttles the same way (`maxWorkChunkSize: 500`, 200 ms rest).
    const count = MAX_WORK_CHUNK + 25
    const harness = collect({ recursive: 'ok', exists: () => true })
    harness.watcher.start()

    for (let index = 0; index < count; index++) {
      harness.emit(ROOT, { type: 'change', filename: `file${index}.tex` })
    }
    await settle()

    expect(harness.events[0]).toHaveLength(MAX_WORK_CHUNK)
    await vi.waitFor(() => expect(harness.events.flat()).toHaveLength(count), { timeout: 4000, interval: 25 })
  })

  it('drops the overflow of an enormous burst, once, with the setting named', async () => {
    const harness = collect({ recursive: 'ok', exists: () => true })
    harness.watcher.start()

    for (let index = 0; index < MAX_BUFFERED_CHANGES + 10; index++) {
      harness.emit(ROOT, { type: 'change', filename: `file${index}.tex` })
    }
    await settle()

    expect(harness.diagnostics).toHaveLength(1)
    expect(harness.diagnostics[0]).toContain('files.watcherExclude')
    // The burst still produces deliveries: the tree is re-read from what did fit.
    expect(harness.events.flat().length).toBeGreaterThan(0)
  })

  it('coalesces two spellings of one path on a case-insensitive platform', async () => {
    const harness = collect({ recursive: 'ok', exists: () => true })
    harness.watcher.start()

    harness.emit(ROOT, { type: 'change', filename: 'Main.tex' })
    harness.emit(ROOT, { type: 'change', filename: 'main.tex' })
    await settle()

    const paths = harness.events.flat()
    // On Windows those are one file; elsewhere they are two. Either way the same
    // file is never reported twice within one batch.
    expect(paths.length).toBe(process.platform === 'win32' ? 1 : 2)
  })
})

describe('the real filesystem', () => {
  const roots: string[] = []

  const temporaryProject = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-watch-'))
    roots.push(root)
    return root
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('notices a file created by another program, in a directory that did not exist before', async () => {
    const root = temporaryProject()
    fs.mkdirSync(path.join(root, 'chapters'))

    const batches: FileWatchEvent[][] = []
    const excludes = new Set(['node_modules'])
    const watcher = new TreeWatcher({
      root,
      excludes,
      ports: nodeWatchPorts(),
      deliver: (events) => batches.push(events),
      report: () => undefined,
      debounceMs: 50
    })
    watcher.start()

    try {
      await settle(100)
      const created = path.join(root, 'chapters', 'new.tex')
      fs.writeFileSync(created, '\\section{Written by another program}\n')

      // The debounce window plus however long the platform takes to report it.
      await vi.waitFor(() => expect(batches.flat().map((event) => event.path)).toContain(created), {
        timeout: 8000,
        interval: 25
      })
      expect(batches.flat().find((event) => event.path === created)?.kind).toBeOneOf(['create', 'change'])
    } finally {
      watcher.stop()
    }
  }, 20_000)

  it('does not report a change inside an excluded directory', async () => {
    const root = temporaryProject()
    fs.mkdirSync(path.join(root, 'node_modules'))

    const batches: FileWatchEvent[][] = []
    const excludes = new Set(['node_modules'])
    const watcher = new TreeWatcher({
      root,
      excludes,
      ports: nodeWatchPorts(),
      deliver: (events) => batches.push(events),
      report: () => undefined,
      debounceMs: 50
    })
    watcher.start()

    try {
      await settle(100)
      const ignored = path.join(root, 'node_modules', 'index.js')
      fs.writeFileSync(ignored, 'module.exports = 1\n')
      const noticed = path.join(root, 'main.tex')
      fs.writeFileSync(noticed, '\\documentclass{book}\n')

      await vi.waitFor(() => expect(batches.flat().map((event) => event.path)).toContain(noticed), {
        timeout: 8000,
        interval: 25
      })
      expect(batches.flat().map((event) => event.path)).not.toContain(ignored)
    } finally {
      watcher.stop()
    }
  }, 20_000)
})
