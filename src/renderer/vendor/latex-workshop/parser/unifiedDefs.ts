/**
 * Eukolia — LaTeX Workshop port: macro/environment definitions for the AST
 * argument attacher.
 *
 * Ported from `out/src/parse/parser/unified-defs.js` of LaTeX Workshop 10.19.0.
 * `attachMacroArgs` needs a signature for every macro whose arguments must be
 * recognised; the reference derives the sectioning and outline-command
 * signatures from the `view.outline.*` settings, which is preserved here.
 */

import { setting, settingOr, type LwSettings } from '../settings'

export interface MacroDef {
  signature: string
}

const MACROS: Record<string, MacroDef> = {
  // \input{some-file}
  InputIfFileExists: { signature: 'm' },
  SweaveInput: { signature: 'm' },
  subfile: { signature: 'm' },
  subfileinclude: { signature: 'm' },
  loadglsentries: { signature: 'm' },
  markdownInput: { signature: 'm' },
  // \import{sections/}{some-file}
  import: { signature: 'm m' },
  inputfrom: { signature: 'm m' },
  includefrom: { signature: 'm m' },
  subimport: { signature: 'm m' },
  subinputfrom: { signature: 'm m' },
  subincludefrom: { signature: 'm m' },
  // \label{some-label}
  linelabel: { signature: 'd<> o m' },
  // \newglossaryentry{vscode}{name=VSCode, description=Editor}
  newglossaryentry: { signature: 'm m' },
  provideglossaryentry: { signature: 'm m' },
  // \newacronym[optional parameters]{lw}{LW}{LaTeX Workshop}
  longnewglossaryentry: { signature: 'o m m m' },
  longprovideglossaryentry: { signature: 'o m m m' },
  newacronym: { signature: 'o m m m' },
  newabbreviation: { signature: 'o m m m' },
  newabbr: { signature: 'o m m m' },
  newrobustcmd: { signature: 's d<> +m o +o +m' },
  renewrobustcmd: { signature: 's d<> +m o +o +m' },
  providerobustcmd: { signature: 's +m o +o +m' },
  DeclareRobustCommand: { signature: 's +m o +o +m' },
  DeclareMathOperator: { signature: 's m m' },
  DeclarePairedDelimiter: { signature: 'm m m' },
  DeclarePairedDelimiterX: { signature: 'm o m m m' },
  DeclarePairedDelimiterXPP: { signature: 'm o m m m m m' }
}

const ENVS: Record<string, MacroDef> = {}

/** `getMacroDefs` of the reference. */
export function getMacroDefs(settings: LwSettings): Record<string, MacroDef> {
  const cmds = [
    ...new Set([
      ...setting<string[]>(settings, 'view.outline.commands'),
      ...setting<string[]>(settings, 'intellisense.label.command')
    ])
  ]
  const secs = settingOr<string[]>(settings, 'view.outline.sections', []).map((level) => level.split('|')).flat()
  const macroDefs: Record<string, MacroDef> = { ...MACROS }
  cmds.forEach((cmd) => (macroDefs[cmd] = { signature: 'd<> o m' }))
  secs.forEach((sec) => (macroDefs[sec] = { signature: 's o m' }))
  return macroDefs
}

/** `getEnvDefs` of the reference. */
export function getEnvDefs(): Record<string, MacroDef> {
  return ENVS
}

/** `refreshLaTeXModelConfig` of `outline/structure/latex.js`. */
export interface LatexStructureConfig {
  macros: { cmds: string[]; envs: string[]; secs: string[] }
  secIndex: Record<string, number>
  texDirs: string[]
  subFile: boolean
  caption: boolean
  documentClass?: string
}

export function refreshLatexModelConfig(settings: LwSettings, subFile = true, defaultFloats: string[] = ['frame']): LatexStructureConfig {
  const structConfig: LatexStructureConfig = {
    macros: {
      cmds: setting<string[]>(settings, 'view.outline.commands'),
      envs: settingOr<boolean>(settings, 'view.outline.floats.enabled', true) ? ['figure', 'table', ...defaultFloats] : defaultFloats,
      secs: []
    },
    secIndex: {},
    texDirs: settingOr<string[]>(settings, 'latex.texDirs', []),
    subFile,
    caption: settingOr<boolean>(settings, 'view.outline.floats.caption.enabled', true)
  }
  const hierarchy = settingOr<string[]>(settings, 'view.outline.sections', [])
  hierarchy.forEach((sec, index) => {
    sec.split('|').forEach((cmd) => {
      structConfig.secIndex[cmd] = index
    })
  })
  structConfig.macros.secs = hierarchy.map((sec) => sec.split('|')).flat()
  return structConfig
}
