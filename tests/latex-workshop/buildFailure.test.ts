/**
 * Why a build failed.
 *
 * Every one of these cases used to reach the shell as the same two words —
 * `Build failed` — because nothing read `BuildStepResult.code`, the spawn error
 * or the recipe error. The panel that opened was the Problems list, which is
 * empty when the failure happened before any compiler ran.
 *
 * So the assertions here are about *sentences*: which command, which code, which
 * reason, and whose fault it is (the recipe, the machine, or the document).
 */

import { describe, expect, it } from 'vitest'

import type { BuildResult, BuildStepResult } from '../../src/shared/ipc'
import {
  describeBuildFailure,
  failureDiagnostic,
  firstErrorDetail,
  formatBuildFailure
} from '../../src/renderer/compiler/buildFailure'
import type { DiagnosticItem } from '../../src/renderer/compiler/logParser'

function step(overrides: Partial<BuildStepResult> = {}): BuildStepResult {
  return {
    label: 'pdflatex (main)',
    command: 'pdflatex',
    args: ['-interaction=nonstopmode', 'main.tex'],
    code: 0,
    signal: null,
    durationMs: 120,
    spawnFailed: false,
    ...overrides
  }
}

function result(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    jobId: 'job-1',
    success: false,
    code: 0,
    log: '',
    steps: [step()],
    pdfPath: null,
    synctexPath: null,
    durationMs: 500,
    cancelled: false,
    ...overrides
  }
}

function diagnostic(overrides: Partial<DiagnosticItem> = {}): DiagnosticItem {
  return {
    file: 'C:/proj/main.tex',
    line: 12,
    severity: 'error',
    message: 'Undefined control sequence.',
    source: 'latex',
    level: 'error',
    raw: '! Undefined control sequence.',
    category: 'compiler-error',
    ...overrides
  }
}

describe('a build that ran and failed', () => {
  it('names the command and its exit code, and quotes the compiler', () => {
    const failure = describeBuildFailure(
      result({ steps: [step({ code: 1 })], code: 1 }),
      { diagnostics: [diagnostic()], jobName: 'main' }
    )
    expect(failure).not.toBeNull()
    expect(failure!.kind).toBe('exit')
    expect(failure!.message).toBe('pdflatex exited with code 1')
    expect(formatBuildFailure(failure!)).toBe('pdflatex exited with code 1 — Undefined control sequence.')
    expect(failure!.command).toBe('pdflatex -interaction=nonstopmode main.tex')
    expect(failure!.step).toBe('pdflatex (main)')
  })

  it('says which step of how many failed', () => {
    const failure = describeBuildFailure(
      result({
        steps: [step({ command: 'pdflatex', code: 0 }), step({ command: 'bibtex', code: 2 })],
        code: 2
      }),
      { jobName: 'main' }
    )
    expect(failure!.message).toBe('bibtex exited with code 2 (step 2 of 2)')
    expect(failure!.stepIndex).toBe(2)
    expect(failure!.totalSteps).toBe(2)
  })

  it('reports a step that was killed after its time limit', () => {
    const failure = describeBuildFailure(
      result({
        log: '\n[eukolia] step timed out after 60000 ms and was terminated\n',
        steps: [step({ code: null, signal: null, spawnFailed: false })]
      }),
      { jobName: 'main' }
    )
    expect(failure!.kind).toBe('timeout')
    expect(failure!.message).toContain('time limit')
  })

  it('reports a build whose steps all succeeded but produced no PDF', () => {
    const failure = describeBuildFailure(result({ steps: [step({ code: 0 })], code: 0 }), { jobName: 'main' })
    expect(failure!.kind).toBe('output')
    expect(failure!.message).toBe('The build finished but produced no main.pdf')
  })
})

describe('a build that never started', () => {
  it('reports the missing command as the launch error, not as an exit code', () => {
    // `spawn` reports a missing binary asynchronously: the call succeeds and the
    // `error` event carries ENOENT, so without carrying that message out of the
    // main process this is indistinguishable from a compiler that exited 1.
    const failure = describeBuildFailure(
      result({
        steps: [step({ code: null, signal: null, spawnFailed: true, errorMessage: 'spawn pdflatex ENOENT' })],
        code: null
      }),
      { jobName: 'main' }
    )
    expect(failure!.kind).toBe('launch')
    expect(failure!.message).toBe('spawn pdflatex ENOENT')
    expect(failure!.launchError).toBe('spawn pdflatex ENOENT')
    expect(failure!.code).toBeNull()
  })

  it('falls back to a sentence when the operating system said nothing', () => {
    const failure = describeBuildFailure(
      result({ steps: [step({ code: null, signal: null, spawnFailed: true })], code: null }),
      { jobName: 'main' }
    )
    expect(failure!.message).toBe('pdflatex could not be started')
  })
})

describe('outcomes that are not failures', () => {
  it('says nothing about a successful build', () => {
    expect(describeBuildFailure(result({ success: true, pdfPath: 'C:/proj/main.pdf' }))).toBeNull()
  })

  it('says nothing about a build the user cancelled', () => {
    // A cancelled run leaves a step with no exit code and no signal, which is
    // also what a launch failure looks like; the cancellation is what decides it.
    expect(
      describeBuildFailure(result({ cancelled: true, steps: [step({ code: null, signal: null, spawnFailed: true })] }))
    ).toBeNull()
  })

  it('reports a recipe that resolved to nothing as a recipe failure', () => {
    const failure = describeBuildFailure(result({ steps: [], code: null }), { jobName: 'main' })
    expect(failure!.kind).toBe('output')
    expect(failure!.message).toBe('The build ran no steps.')
  })
})

describe('the first compiler error', () => {
  it('is the first error, not the first warning', () => {
    const detail = firstErrorDetail([
      diagnostic({ severity: 'warning', message: 'Reference `x` undefined', level: 'warning' }),
      diagnostic({ message: 'Missing $ inserted.' })
    ])
    expect(detail).toBe('Missing $ inserted.')
  })

  it('is flattened and bounded, because it goes in a one-line strip', () => {
    const detail = firstErrorDetail([diagnostic({ message: `line one\n${'x'.repeat(400)}` })])
    expect(detail!.startsWith('line one x')).toBe(true)
    expect(detail!.length).toBeLessThanOrEqual(220)
    expect(detail!.endsWith('…')).toBe(true)
  })

  it('is absent when the compiler reported no error', () => {
    expect(firstErrorDetail([diagnostic({ severity: 'warning' })])).toBeUndefined()
  })
})

describe('the Problems entry a build failure adds', () => {
  it('is an error, carries no line, and says which kind of failure it was', () => {
    const failure = describeBuildFailure(
      result({ steps: [step({ spawnFailed: true, errorMessage: 'spawn xelatex ENOENT', code: null })], code: null }),
      { jobName: 'main' }
    )!
    const item = failureDiagnostic(failure, 'C:/proj/main.tex')
    expect(item.severity).toBe('error')
    expect(item.level).toBe('error')
    expect(item.category).toBe('build')
    expect(item.code).toBe('eukolia.build.launch')
    // Line 0 is what makes the row inert: there is nowhere to navigate to, and
    // the panel keys "can this be opened?" off a positive line number.
    expect(item.line).toBe(0)
    expect(item.file).toBe('C:/proj/main.tex')
    expect(item.message).toBe('spawn xelatex ENOENT')
  })
})
