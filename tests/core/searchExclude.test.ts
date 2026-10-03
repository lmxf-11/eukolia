// @vitest-environment node
/**
 * What project search excludes.
 *
 * VS Code's rule, quoted in `VSCODE-FILES-AND-FOLDERS.md` §3: `search.exclude`
 * "Inherits all glob patterns from the `files.exclude#` setting", and the search
 * service merges the two with the search-specific value winning. Eukolia's excludes
 * are lists of directory names rather than glob→boolean objects, so the merge is a
 * union, and it is a function beside the settings rather than an expression at the
 * call site so it can be tested without a window.
 *
 * A value of the wrong shape never reaches this function — `setValue` rejects it
 * against the schema and `applyAdvancedSettings` ignores it with a warning — so
 * there is deliberately no test here for one.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { setting, settingsManager } from '@core/settings'

const KEYS = ['files.exclude', 'search.exclude'] as const

afterEach(() => {
  for (const key of KEYS) settingsManager.reset(key)
})

describe('setting.searchExcludeDirectories', () => {
  it('sends the Explorer excludes, because search inherits them', () => {
    settingsManager.setValue('files.exclude', ['.git', 'node_modules', 'build'], 'user')
    settingsManager.setValue('search.exclude', [], 'user')

    expect(setting.searchExcludeDirectories()).toEqual(['.git', 'node_modules', 'build'])
  })

  it('adds what search excludes on top', () => {
    settingsManager.setValue('files.exclude', ['build'], 'user')
    settingsManager.setValue('search.exclude', ['vendor'], 'user')

    expect(setting.searchExcludeDirectories()).toEqual(['build', 'vendor'])
  })

  it('does not lose either list when the same name is in both', () => {
    // The union is the name-list spelling of VS Code's "search wins" overwrite: a
    // duplicate is idempotent, so nothing needs to win for the answer to be right.
    settingsManager.setValue('files.exclude', ['build', 'node_modules'], 'user')
    settingsManager.setValue('search.exclude', ['node_modules'], 'user')

    const excludes = setting.searchExcludeDirectories()
    expect(new Set(excludes)).toEqual(new Set(['build', 'node_modules']))
  })

  it('answers with the defaults when nothing has been configured', () => {
    // Both keys have defaults, and search's own are the dependency directories VS
    // Code ships: **/node_modules, **/bower_components.
    expect(setting.searchExcludeDirectories()).toContain('node_modules')
  })
})
