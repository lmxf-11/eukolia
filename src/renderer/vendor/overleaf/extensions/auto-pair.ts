import { keymap } from '@codemirror/view'
import { Compartment, EditorState, Prec, TransactionSpec } from '@codemirror/state'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { closeBracketConfig } from '../languages/latex/close-bracket-config'

const autoPairConf = new Compartment()

export const autoPair = ({
  autoPairDelimiters,
}: {
  autoPairDelimiters: boolean
}) => autoPairConf.of(autoPairDelimiters ? extension : [])

export const setAutoPair = (autoPairDelimiters: boolean): TransactionSpec => {
  return {
    effects: autoPairConf.reconfigure(autoPairDelimiters ? extension : []),
  }
}

/**
 * The built-in closeBrackets extension and closeBrackets keymap.
 */
const extension = [
  EditorState.languageData.of(() => [{ closeBrackets: closeBracketConfig }]),
  closeBrackets(),
  // NOTE: using Prec.highest as this needs to run before the default Backspace handler
  Prec.highest(keymap.of(closeBracketsKeymap)),
]
