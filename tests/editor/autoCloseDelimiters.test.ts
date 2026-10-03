import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { insertBracket } from '@codemirror/autocomplete'
import { SETTINGS_SCHEMA, settingsManager } from '@/core/settings'
import {
  closeBracketConfig,
  getActiveCloseBrackets,
} from '@/vendor/overleaf/languages/latex/close-bracket-config'
import { autoPair } from '@/vendor/overleaf/extensions/auto-pair'

describe('Delimiter auto-closing settings', () => {
  const originalSettings: Record<string, unknown> = {}

  const SETTING_KEYS = [
    'editor.smartDelimiters',
    'editor.autoCloseSquareBrackets',
    'editor.autoCloseCurlyBraces',
    'editor.autoCloseParentheses',
    'editor.autoCloseDollarSigns',
    'editor.autoCloseQuotes',
  ] as const

  beforeEach(() => {
    for (const key of SETTING_KEYS) {
      originalSettings[key] = settingsManager.getValue(key)
    }
  })

  afterEach(() => {
    for (const key of SETTING_KEYS) {
      settingsManager.setValue(key, originalSettings[key], 'user')
    }
  })

  describe('SETTINGS_SCHEMA entries', () => {
    it('defines all 5 individual delimiter settings and master toggle under Editor category', () => {
      const keys = [
        'editor.smartDelimiters',
        'editor.autoCloseSquareBrackets',
        'editor.autoCloseCurlyBraces',
        'editor.autoCloseParentheses',
        'editor.autoCloseDollarSigns',
        'editor.autoCloseQuotes',
      ]

      for (const key of keys) {
        const desc = SETTINGS_SCHEMA.find(s => s.key === key)
        expect(desc, `Missing schema descriptor for ${key}`).toBeDefined()
        expect(desc?.category).toBe('Editor')
        expect(desc?.type).toBe('boolean')
      }
    })

    it('has correct default values', () => {
      expect(settingsManager.getValue('editor.smartDelimiters')).toBe(true)
      expect(settingsManager.getValue('editor.autoCloseSquareBrackets')).toBe(true)
      expect(settingsManager.getValue('editor.autoCloseCurlyBraces')).toBe(true)
      expect(settingsManager.getValue('editor.autoCloseParentheses')).toBe(true)
      expect(settingsManager.getValue('editor.autoCloseDollarSigns')).toBe(true)
      expect(settingsManager.getValue('editor.autoCloseQuotes')).toBe(false)
    })
  })

  describe('getActiveCloseBrackets() resolution', () => {
    it('returns standard Overleaf brackets with default settings', () => {
      const brackets = getActiveCloseBrackets()
      expect(brackets).toEqual(['$', '$$', '[', '{', '('])
    })

    it('returns empty array when master switch editor.smartDelimiters is false', () => {
      settingsManager.setValue('editor.smartDelimiters', false, 'user')
      expect(getActiveCloseBrackets()).toEqual([])
    })

    it('excludes square brackets when editor.autoCloseSquareBrackets is false', () => {
      settingsManager.setValue('editor.autoCloseSquareBrackets', false, 'user')
      const brackets = getActiveCloseBrackets()
      expect(brackets).not.toContain('[')
      expect(brackets).toContain('{')
      expect(brackets).toContain('(')
      expect(brackets).toContain('$')
    })

    it('excludes curly braces when editor.autoCloseCurlyBraces is false', () => {
      settingsManager.setValue('editor.autoCloseCurlyBraces', false, 'user')
      const brackets = getActiveCloseBrackets()
      expect(brackets).toContain('[')
      expect(brackets).not.toContain('{')
      expect(brackets).toContain('(')
      expect(brackets).toContain('$')
    })

    it('excludes parentheses when editor.autoCloseParentheses is false', () => {
      settingsManager.setValue('editor.autoCloseParentheses', false, 'user')
      const brackets = getActiveCloseBrackets()
      expect(brackets).toContain('[')
      expect(brackets).toContain('{')
      expect(brackets).not.toContain('(')
      expect(brackets).toContain('$')
    })

    it('excludes dollar signs when editor.autoCloseDollarSigns is false', () => {
      settingsManager.setValue('editor.autoCloseDollarSigns', false, 'user')
      const brackets = getActiveCloseBrackets()
      expect(brackets).toContain('[')
      expect(brackets).toContain('{')
      expect(brackets).toContain('(')
      expect(brackets).not.toContain('$')
      expect(brackets).not.toContain('$$')
    })

    it('includes quotes when editor.autoCloseQuotes is true', () => {
      settingsManager.setValue('editor.autoCloseQuotes', true, 'user')
      const brackets = getActiveCloseBrackets()
      expect(brackets).toContain('"')
      expect(brackets).toContain("'")
    })
  })

  describe('CodeMirror 6 bracket insertion integration', () => {
    function createTestState(docText = '') {
      return EditorState.create({
        doc: docText,
        extensions: [
          autoPair({ autoPairDelimiters: true }),
        ],
      })
    }

    it('auto-closes [ to [] only when editor.autoCloseSquareBrackets is true', () => {
      settingsManager.setValue('editor.autoCloseSquareBrackets', true, 'user')
      const state1 = createTestState()
      const tr1 = insertBracket(state1, '[')
      expect(tr1).not.toBeNull()
      expect(tr1?.newDoc.toString()).toBe('[]')
      expect(tr1?.selection.main.head).toBe(1)

      settingsManager.setValue('editor.autoCloseSquareBrackets', false, 'user')
      const state2 = createTestState()
      const tr2 = insertBracket(state2, '[')
      expect(tr2).toBeNull()
    })

    it('auto-closes { to {} only when editor.autoCloseCurlyBraces is true', () => {
      settingsManager.setValue('editor.autoCloseCurlyBraces', true, 'user')
      const state1 = createTestState()
      const tr1 = insertBracket(state1, '{')
      expect(tr1).not.toBeNull()
      expect(tr1?.newDoc.toString()).toBe('{}')
      expect(tr1?.selection.main.head).toBe(1)

      settingsManager.setValue('editor.autoCloseCurlyBraces', false, 'user')
      const state2 = createTestState()
      const tr2 = insertBracket(state2, '{')
      expect(tr2).toBeNull()
    })

    it('auto-closes ( to () only when editor.autoCloseParentheses is true', () => {
      settingsManager.setValue('editor.autoCloseParentheses', true, 'user')
      const state1 = createTestState()
      const tr1 = insertBracket(state1, '(')
      expect(tr1).not.toBeNull()
      expect(tr1?.newDoc.toString()).toBe('()')
      expect(tr1?.selection.main.head).toBe(1)

      settingsManager.setValue('editor.autoCloseParentheses', false, 'user')
      const state2 = createTestState()
      const tr2 = insertBracket(state2, '(')
      expect(tr2).toBeNull()
    })

    it('auto-closes $ to $$ only when editor.autoCloseDollarSigns is true', () => {
      settingsManager.setValue('editor.autoCloseDollarSigns', true, 'user')
      const state1 = createTestState()
      const tr1 = insertBracket(state1, '$')
      expect(tr1).not.toBeNull()
      expect(tr1?.newDoc.toString()).toBe('$$')
      expect(tr1?.selection.main.head).toBe(1)

      settingsManager.setValue('editor.autoCloseDollarSigns', false, 'user')
      const state2 = createTestState()
      const tr2 = insertBracket(state2, '$')
      expect(tr2).toBeNull()
    })

    it('auto-closes quotes only when editor.autoCloseQuotes is true', () => {
      settingsManager.setValue('editor.autoCloseQuotes', false, 'user')
      const state1 = createTestState()
      expect(insertBracket(state1, '"')).toBeNull()
      expect(insertBracket(state1, "'")).toBeNull()

      settingsManager.setValue('editor.autoCloseQuotes', true, 'user')
      const state2 = createTestState()
      const trDbl = insertBracket(state2, '"')
      expect(trDbl).not.toBeNull()
      expect(trDbl?.newDoc.toString()).toBe('""')

      const trSgl = insertBracket(state2, "'")
      expect(trSgl).not.toBeNull()
      expect(trSgl?.newDoc.toString()).toBe("''")
    })

    it('does not auto-close any delimiter when editor.smartDelimiters is false', () => {
      settingsManager.setValue('editor.smartDelimiters', false, 'user')
      settingsManager.setValue('editor.autoCloseSquareBrackets', true, 'user')
      settingsManager.setValue('editor.autoCloseCurlyBraces', true, 'user')
      settingsManager.setValue('editor.autoCloseParentheses', true, 'user')
      settingsManager.setValue('editor.autoCloseDollarSigns', true, 'user')
      settingsManager.setValue('editor.autoCloseQuotes', true, 'user')

      const state = createTestState()
      expect(insertBracket(state, '[')).toBeNull()
      expect(insertBracket(state, '{')).toBeNull()
      expect(insertBracket(state, '(')).toBeNull()
      expect(insertBracket(state, '$')).toBeNull()
      expect(insertBracket(state, '"')).toBeNull()
      expect(insertBracket(state, "'")).toBeNull()
    })
  })
})
