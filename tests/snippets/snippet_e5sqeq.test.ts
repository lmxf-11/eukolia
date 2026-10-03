import { describe, expect, it } from 'vitest'
import { SnippetEngine } from '@/snippets/engine'
import { parseSnippetFileText, normalizeSnippetFile } from '@/snippets/eusnips/model'
import { tokenizeBody, renderBody, bodySubstitutions } from '@/snippets/eusnips/body'
import { loadEusnipsIntoEngine } from '@/snippets/eusnips/hsnips'
import { createStringDocument } from '@/snippets/documentAdapter'
import type { EusnipsFile } from '@/snippets/eusnips/model'

describe('Snippet e5sqeq verification', () => {
  const e5sqeqBody = "``\nif (m[1]) {\n    rv = m[3];\n} else {\n    rv = m[2] + \"\\\\$\" + m[3];\n}\n``/``rv = m[5]``\\$``rv = m[7]``"

  /**
   * The snippet as a document, rather than as a file on this machine.
   *
   * These tests used to read `D:/XPlace/snippets.json` — a path from a working copy
   * that no longer holds this snippet — so they failed for everyone, on every run,
   * for a reason that had nothing to do with the code they test. The definition below
   * is `e5sqeq` as it stands in the library: same trigger, same body, same context.
   * A parser test should not depend on where a project happens to be checked out.
   */
  const e5sqeq: EusnipsFile = {
    version: 1,
    snippets: [
      {
        id: 'e5sqeq',
        trigger: { pattern: "(\\$)?(?<!\\.)(\\s*,|\\s+)([A-Za-z]('*))/([A-Za-z]('*))([\\-.,;]?\\s)" },
        description: 'auto',
        priority: 1000,
        expand: 'auto',
        boundary: 'anywhere',
        context: 'text',
        body: e5sqeqBody
      }
    ]
  }

  const e5sqeqFile = () => normalizeSnippetFile(parseSnippetFileText(JSON.stringify(e5sqeq)).file!)

  it('tokenizes snippet e5sqeq body without false-positive substitutions', () => {
    const tokens = tokenizeBody(e5sqeqBody)
    expect(tokens).toHaveLength(5)
    expect(tokens[0].type).toBe('javascript')
    expect(tokens[1]).toEqual({ type: 'text', value: '/' })
    expect(tokens[2]).toEqual({ type: 'javascript', code: 'rv = m[5]' })
    expect(tokens[3]).toEqual({ type: 'text', value: '\\$' })
    expect(tokens[4]).toEqual({ type: 'javascript', code: 'rv = m[7]' })

    const substitutions = bodySubstitutions(e5sqeqBody)
    expect(substitutions).toEqual([])

    // Source string round-trips exactly
    expect(renderBody(e5sqeqBody)).toBe(e5sqeqBody)

    // Tokenized form round-trips semantically through renderBody and tokenizeBody
    const roundTripped = tokenizeBody(renderBody(tokens))
    expect(roundTripped.map(t => t.type)).toEqual(tokens.map(t => t.type))
    expect(roundTripped[1]).toEqual(tokens[1]) // text '/'
    expect(roundTripped[2]).toEqual(tokens[2]) // javascript 'rv = m[5]'
    expect(roundTripped[3]).toEqual(tokens[3]) // text '\$'
    expect(roundTripped[4]).toEqual(tokens[4]) // javascript 'rv = m[7]'
  })

  it('does not treat solitary slashes as unclosed substitutions', () => {
    expect(tokenizeBody('$1/2')).toEqual([
      { type: 'tabstop', index: 1 },
      { type: 'text', value: '/2' }
    ])
    expect(bodySubstitutions('$1/2')).toEqual([])

    expect(tokenizeBody('``rv = "x"``/y')).toEqual([
      { type: 'javascript', code: 'rv = "x"' },
      { type: 'text', value: '/y' }
    ])
    expect(bodySubstitutions('``rv = "x"``/y')).toEqual([])

    // Genuine substitution with at least two slashes is still parsed
    expect(tokenizeBody('${1/find/replace/}')).toEqual([
      { type: 'tabstop', index: 1, transform: '/find/replace/' }
    ])
    expect(bodySubstitutions('${1/find/replace/}')).toEqual(['/find/replace/'])
  })

  it('normalizes snippet file with 0 substitution issues for e5sqeq', () => {
    const normalized = e5sqeqFile()

    const target = normalized.snippets.find(s => s.id === 'e5sqeq')
    expect(target).toBeDefined()

    const issues = normalized.issues.filter(i => i.id === 'e5sqeq')
    expect(issues).toEqual([])
  })

  it('expands e5sqeq correctly outside math', () => {
    const normalized = e5sqeqFile()

    const engine = new SnippetEngine()
    loadEusnipsIntoEngine(engine, [normalized])

    engine.setContextProvider({
      createDetector: () => ({
        isMath: () => false,
        getEnvironment: () => undefined,
        getTriggerContext: () => ' a/b ',
        getLineContext: () => ' a/b ',
        getMultiLineContext: () => ' a/b '
      })
    })

    const textBefore = ' a/b '
    const doc = createStringDocument(textBefore, 'latex')
    const candidates = engine.getCompletions({
      text: textBefore,
      offset: 5,
      languageId: 'latex',
      doc
    })
    const candidate = candidates.find(c => c.snippet.id === 'e5sqeq')
    expect(candidate).toBeDefined()

    const expansion = engine.expand(candidate!, { doc })
    expect(expansion.plainText).toBe(' $a/b$ ')
  })

  it('expands e5sqeq correctly when prefix dollar is present in text', () => {
    const normalized = e5sqeqFile()

    const engine = new SnippetEngine()
    loadEusnipsIntoEngine(engine, [normalized])

    engine.setContextProvider({
      createDetector: () => ({
        isMath: () => false,
        getEnvironment: () => undefined,
        getTriggerContext: () => '$ a/b ',
        getLineContext: () => '$ a/b ',
        getMultiLineContext: () => '$ a/b '
      })
    })

    const textBefore = '$ a/b '
    const doc = createStringDocument(textBefore, 'latex')
    const candidates = engine.getCompletions({
      text: textBefore,
      offset: 6,
      languageId: 'latex',
      doc
    })
    const candidate = candidates.find(c => c.snippet.id === 'e5sqeq')
    expect(candidate).toBeDefined()

    const expansion = engine.expand(candidate!, { doc })
    expect(expansion.plainText).toBe('a/b$ ')
  })
})
