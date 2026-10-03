import { describe, expect, it } from 'vitest'
import { SnippetEngine } from '@/snippets/engine'
import { parseSnippetFileText, normalizeSnippetFile } from '@/snippets/eusnips/model'
import { loadEusnipsIntoEngine } from '@/snippets/eusnips/hsnips'
import { createStringDocument } from '@/snippets/documentAdapter'
import { SnippetEditorAdapter } from '@/snippets/editorAdapter'
import { TestEditor } from './helpers'
import type { EusnipsFile } from '@/snippets/eusnips/model'

/**
 * The snippet as a document, rather than as a file on this machine.
 *
 * These tests used to read the user's own library out of
 * `C:/Users/Yinji/AppData/Roaming/eukolia/User/snippets/snippets.json`, and they
 * failed once that library moved — the snippet is not in it any more, so `target` was
 * undefined and every assertion after it was unreachable. What they test is the
 * engine's handling of a body that generates its placeholders from a JavaScript block,
 * which is a property of the snippet, not of where it is stored. The definition below
 * is `65hkq8` as it stands in the library today.
 */
/**
 * The one global the body calls, mirrored from the library's `globals.js`.
 *
 * `65hkq8`'s body starts with `rv = displayMathPrefix(m)`, and the test used to get
 * that function — along with the rest of a 186 KB script — out of the library file it
 * read from disk. A fixture that omits it does not test the snippet at all: the code
 * block throws, the expansion comes back with no placeholders, and the assertion that
 * fails is about the fixture rather than about the engine. This is the function as the
 * library defines it, verbatim.
 */
const DISPLAY_MATH_PREFIX = `function displayMathPrefix(match) {
  if (match && typeof match[2] !== "undefined" && match[2] !== "") {
    const math = match[2].replace(/\\$/g, "\\\\$");
    return match[1] + math + "\\n" + match[1];
  }
  return (match && match[1]) || "";
}`

const displayMath: EusnipsFile = {
  version: 1,
  globals: { javascript: DISPLAY_MATH_PREFIX },
  snippets: [
    {
      id: '65hkq8',
      trigger: { pattern: '(\\s*)(.*)dg4' },
      description: 'Display math',
      priority: 1000,
      expand: 'auto',
      boundary: 'anywhere',
      context: 'math',
      body: "``rv = displayMathPrefix(m);````\nconst content = \"\\\\begin{tikzcd}\\n  { } \\\\ar[r,\\\" \\\"] \\\\ar[d,\\\" \\\"\\']& { } \\\\ar[d,\\\" \\\"] \\\\\\\\ \\n  { } \\\\ar[r,\\\" \\\"\\']           & { }           \\n\\\\end{tikzcd}\";\nconst regex = /\"\\s\"|\\{\\s\\}|\\n|\\\\\\\\/g;\nlet n = 1;\n    rv = content.replace(regex, (match) => {\nif (match === '\\\\\\\\') {\n\n  return '\\\\\\\\\\\\'; \n}\nif (match === '\\n')\n  return '\\n' + m[1]; \n\nconst currentN = n++; \n\nif (match === '\" \"') {\n  return `\"\\${${currentN}: }\"`;\n} else if (match === '{ }') {\n  return `{\\${${currentN}: }}`;\n}\n    });\n``"
    }
  ]
}

const displayMathFile = () => normalizeSnippetFile(parseSnippetFileText(JSON.stringify(displayMath)).file!)

describe('Snippet 65hkq8 reproduction & verification', () => {
  it('loads, expands snippet 65hkq8 and navigates all 8 dynamic placeholders', () => {
    const normalized = displayMathFile()

    const target = normalized.snippets.find(s => s.id === '65hkq8')
    expect(target).toBeDefined()

    const engine = new SnippetEngine()
    loadEusnipsIntoEngine(engine, [normalized])

    engine.setContextProvider({
      createDetector: () => ({
        isMath: () => true,
        getEnvironment: () => undefined,
        getTriggerContext: () => 'dg4',
        getLineContext: () => '  dg4',
        getMultiLineContext: () => '  dg4'
      })
    })

    const textBefore = '  dg4'
    const doc = createStringDocument(textBefore, 'latex')
    const candidates = engine.getCompletions({
      text: textBefore,
      offset: 5,
      languageId: 'latex',
      doc
    })
    expect(candidates.length).toBeGreaterThan(0)
    const candidate = candidates[0]

    const expansion = engine.expand(candidate, { doc })

    // Verify all 8 placeholders generated dynamically in the JS code block are registered
    expect(expansion.placeholderIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0])
    expect(expansion.selectedPlaceholder).toBe(1)

    // Verify geometry and placeholders
    const geometry = engine.getGeometry(expansion)
    expect(geometry.placeholders.filter(p => p.id !== 0)).toHaveLength(8)
    for (let id = 1; id <= 8; id++) {
      const p = geometry.placeholders.find(x => x.id === id)
      expect(p).toBeDefined()
      // Each placeholder in 65hkq8 was initialized as ${currentN: } with content ' '
      expect(geometry.text.slice(p!.from, p!.to)).toBe(' ')
    }

    // Verify Tab navigation moves through each placeholder in order 1 -> 8 -> 0
    for (let id = 2; id <= 8; id++) {
      expect(engine.hasMoreTabStops()).toBe(true)
      const nextExp = engine.nextTabStop()
      expect(nextExp).toBe(expansion)
      expect(expansion.selectedPlaceholder).toBe(id)
    }

    // Moving past 8 should land on 0 (finishing tab stop)
    expect(engine.hasMoreTabStops()).toBe(true)
    const finalExp = engine.nextTabStop()
    expect(finalExp).toBe(expansion)
    expect(expansion.selectedPlaceholder).toBe(0)

    // Test backward navigation: expand again and move 1 -> 2 -> 3 -> 2 -> 1
    const expansion2 = engine.expand(candidate, { doc })
    expect(expansion2.selectedPlaceholder).toBe(1)
    expect(engine.hasEarlierTabStops()).toBe(false)

    engine.nextTabStop() // moves to 2
    expect(expansion2.selectedPlaceholder).toBe(2)
    expect(engine.hasEarlierTabStops()).toBe(true)

    engine.nextTabStop() // moves to 3
    expect(expansion2.selectedPlaceholder).toBe(3)

    const prevExp = engine.previousTabStop() // moves back to 2
    expect(prevExp).toBe(expansion2)
    expect(expansion2.selectedPlaceholder).toBe(2)

    const prevExp2 = engine.previousTabStop() // moves back to 1
    expect(prevExp2).toBe(expansion2)
    expect(expansion2.selectedPlaceholder).toBe(1)
  })

  it('updates dynamic placeholder text and preserves subsequent placeholder offsets via editor adapter', () => {
    const normalized = displayMathFile()

    const engine = new SnippetEngine()
    loadEusnipsIntoEngine(engine, [normalized])

    engine.setContextProvider({
      createDetector: () => ({
        isMath: () => true,
        getEnvironment: () => undefined,
        getTriggerContext: () => 'dg4',
        getLineContext: () => '  dg4',
        getMultiLineContext: () => '  dg4'
      })
    })

    const adapter = new SnippetEditorAdapter({ engine })
    const editor = new TestEditor('  dg4')
    editor.setSelection(5, 5)

    const candidates = adapter.getCompletionCandidates(editor, 5)
    expect(candidates.length).toBeGreaterThan(0)
    const applied = adapter.acceptCompletion(candidates[0], editor)
    expect(applied).not.toBeNull()

    // 1st placeholder is selected
    expect(applied!.selected[0].id).toBe(1)
    const p1 = applied!.selected[0]
    const geomBefore = adapter.geometry(applied!.expansion)

    // Type "A_1" into placeholder 1
    const typed = editor.replaceRange(p1.documentFrom, p1.documentTo, 'A_1')
    adapter.handleEdit(editor, typed)

    // Verify placeholder 1 now has "A_1" in the live editor text and shifted offsets
    const geomAfter = adapter.geometry(applied!.expansion)
    const p1After = geomAfter.placeholders.find(p => p.id === 1)!
    const p2After = geomAfter.placeholders.find(p => p.id === 2)!
    expect(editor.getText().slice(p1After.documentFrom, p1After.documentTo)).toBe('A_1')
    expect(p2After.from).toBe(geomBefore.placeholders.find(p => p.id === 2)!.from + 2)

    // Navigate to next tab stop (2)
    const nextMove = adapter.nextTabStop(editor)
    expect(nextMove).not.toBeNull()
    expect(nextMove!.id).toBe(2)
    expect(editor.getText().slice(nextMove!.from, nextMove!.to)).toBe(' ')
  })
})
