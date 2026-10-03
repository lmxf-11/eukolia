/**
 * The directory a build searches for its tools.
 *
 * `advanced.texPath` exists for one case — a TeX distribution that is installed
 * but not on the `PATH` the application inherited — and it is only useful if the
 * search path a *spawn* gets is the one the user asked for. That is a small
 * function with one subtlety worth pinning down: Windows spells the variable
 * `Path`, and adding a second `PATH` entry beside it does nothing at all, so the
 * spelling that is already there is the one rewritten.
 */

import { describe, expect, it } from 'vitest'

import { pathVariableName, withToolPath } from '../../src/shared/toolPath'

describe('the tool search path', () => {
  it('finds the variable whatever it is spelled', () => {
    expect(pathVariableName({ Path: 'C:\\Windows' })).toBe('Path')
    expect(pathVariableName({ PATH: '/usr/bin' })).toBe('PATH')
    expect(pathVariableName({ path: '/usr/bin' })).toBe('path')
    expect(pathVariableName({})).toBe('PATH')
  })

  it('is the identity when no directory is configured', () => {
    const env = { PATH: '/usr/bin' }
    expect(withToolPath(env, '')).toBe(env)
    expect(withToolPath(env, '   ')).toBe(env)
    expect(withToolPath(env, undefined)).toBe(env)
  })

  it('prepends rather than replaces, keeping the search path the process had', () => {
    // The tools a build needs are not all TeX: `latexmk` is a Perl script on some
    // installations, and MiKTeX's helpers live outside its bin directory.
    const env = withToolPath({ PATH: '/usr/bin' }, '/opt/texlive/bin')
    expect(env.PATH).toBe(`/opt/texlive/bin${process.platform === 'win32' ? ';' : ':'}/usr/bin`)
  })

  it('rewrites the spelling the environment already uses', () => {
    const env = withToolPath({ Path: 'C:\\Windows' }, 'C:\\tex\\bin')
    expect(Object.keys(env)).toEqual(['Path'])
    expect(env.Path?.startsWith('C:\\tex\\bin')).toBe(true)
    expect(env.Path).toContain('C:\\Windows')
  })

  it('handles a process with no search path at all', () => {
    expect(withToolPath({}, '/opt/texlive/bin').PATH).toBe('/opt/texlive/bin')
  })

  it('does not mutate the environment it was given', () => {
    const env = { PATH: '/usr/bin' }
    withToolPath(env, '/opt/texlive/bin')
    expect(env.PATH).toBe('/usr/bin')
  })
})
