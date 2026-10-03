/**
 * Eukolia — LaTeX Workshop port: document structure / outline construction.
 *
 * Ported from `out/src/outline/structure/latex.js` of LaTeX Workshop 10.19.0.
 * Every stage of the reference's pipeline is reproduced:
 *
 *   `constructFile`      — walk the AST of a file, following `\input`/`\include`
 *                          /`\subfile`/`\import`/`\subimport`/`\loadglsentries`
 *                          /`\markdownInput` and noweb `child=` chunks
 *   `parseNode`          — sectioning commands, `\setcounter`, outline commands,
 *                          `appendix`, `frame`, `figure`/`table` floats,
 *                          DocTeX `macro`/`environment` environments, `\input`
 *                          sub-file entries
 *   `insertSubFile`      — splice sub-file structures into their parent
 *   `applySectionCounters` — `\setcounter{section}{n}`
 *   `nestNonSection`     — attach non-sectioning elements to the current section
 *   `nestSection`        — build the section hierarchy from `secIndex`
 *   `fixSectionToLine`   — compute each section's last line
 *   `addFloatNumber`     — "Figure 3.2: caption"
 *   `addSectionNumber`   — "2.1 Introduction"
 *   `traverseSectionTree`— outline-follows-editor lookup
 *
 * Adaptations: the file/AST store is injected instead of `lw.cache`, the root
 * file is a parameter instead of module state, and the settings are passed in —
 * which is what lets the builder run in tests and in a worker.
 */

import path from 'path'

import { setting, type LwSettings } from '../settings'
import { TeXElementType, type AstNode, type AstRoot, type FileProvider, type TeXElement } from '../types'
import { resolveFile, sanitizeInputFilePath } from '../utils/files'
import { InputFileRegExp } from '../utils/inputFileRegexp'
import { argContentToStr, chooseCaption, sanitizeLabel } from './astUtils'
import { refreshLatexModelConfig, type LatexStructureConfig } from './unifiedDefs'

export interface StructureFile {
  content: string
  ast: AstRoot
}

export interface StructureSource {
  /** Port of `lw.cache.get(filePath)` (`content` + `ast`). */
  get(filePath: string): Promise<StructureFile | undefined>
  fs: FileProvider
  settings: LwSettings
  /** Port of `lw.root.file.path`. */
  rootFile?: string
}

function attributesOf(node: AstNode, filePath: string): Pick<TeXElement, 'lineFr' | 'lineTo' | 'filePath' | 'children'> {
  return {
    lineFr: (node.position?.start.line ?? 1) - 1,
    lineTo: (node.position?.end.line ?? 1) - 1,
    filePath,
    children: []
  }
}

/** `getDocumentClass` of the reference. */
export function getDocumentClass(ast: AstRoot | undefined): string | undefined {
  if (ast === undefined) {
    return undefined
  }
  const documentClass = ast.content.find((node) => node.type === 'macro' && node.content === 'documentclass')
  if (documentClass === undefined) {
    return undefined
  }
  const className = argContentToStr(documentClass.args?.[1]?.content ?? []).trim().toLowerCase()
  return className || undefined
}

/**
 * `construct` of the reference: build the outline of `filePath`, resolving
 * sub-files when `subFile` is enabled.
 */
export async function construct(
  filePath: string | undefined,
  source: StructureSource,
  options: { subFile?: boolean } = {}
): Promise<TeXElement[]> {
  const target = filePath ?? source.rootFile
  if (target === undefined) {
    return []
  }
  const subFile = options.subFile ?? true
  const config = refreshLatexModelConfig(source.settings, subFile)
  const structs: Record<string, TeXElement[]> = {}
  await constructFile(target, config, structs, source)
  const rootFile = source.rootFile
  if (rootFile !== undefined) {
    config.documentClass = getDocumentClass((await source.get(rootFile))?.ast)
  }
  // In rare cases, the following struct may be undefined. Typically in tests
  // where roots are changed rapidly.
  let struct = subFile ? insertSubFile(structs, rootFile, structs[target] ?? []) : (structs[target] ?? [])
  struct = applySectionCounters(struct, config)
  struct = nestNonSection(struct)
  struct = nestSection(struct, config)
  fixSectionToLine(struct, config, Number.MAX_SAFE_INTEGER)
  if (subFile && source.settings['view.outline.floats.number.enabled'] !== false) {
    struct = addFloatNumber(struct, config)
  }
  if (subFile && source.settings['view.outline.numbers.enabled'] !== false) {
    struct = addSectionNumber(struct, config)
  }
  return struct
}

async function constructFile(
  filePath: string,
  config: LatexStructureConfig,
  structs: Record<string, TeXElement[]>,
  source: StructureSource
): Promise<void> {
  if (structs[filePath] !== undefined) {
    return
  }
  const file = await source.get(filePath)
  if (!file) {
    return
  }
  const { content, ast } = file
  // Get a list of rnw child chunks
  const rnwSub = await parseRnwChildMacro(content, filePath, source.rootFile ?? '', source)
  // Parse each base-level node. If the node has contents, that function
  // will be called recursively.
  const rootElement: TeXElement = { type: TeXElementType.Macro, name: '', label: '', filePath, lineFr: 0, lineTo: 0, children: [] }
  structs[filePath] = rootElement.children
  let inAppendix = false
  for (const node of ast.content) {
    if (['string', 'parbreak', 'whitespace'].includes(node.type)) {
      continue
    }
    // Appendix is a one-way journey. Once in it, always in it.
    if (await parseNode(node, rnwSub, rootElement, filePath, config, structs, inAppendix, source)) {
      inAppendix = true
    }
  }
}

async function parseNode(
  node: AstNode,
  rnwSub: Array<{ subFile: string; path: string; line: number }>,
  root: TeXElement,
  filePath: string,
  config: LatexStructureConfig,
  structs: Record<string, TeXElement[]>,
  inAppendix: boolean,
  source: StructureSource
): Promise<boolean> {
  const attributes = attributesOf(node, filePath)
  let element: TeXElement | undefined

  if (node.type === 'macro' && config.macros.secs.includes(node.content as string) && node.args?.[2]?.openMark === '{') {
    // To use a macro as an outline item, the macro must have an explicit
    // mandatory argument e.g. \section{} instead of \section. This is to
    // ignore cases like \titleformat{\section} when \titleformat is not
    // globbing arguments in unified-latex.
    element = {
      type: node.args?.[0]?.content[0] ? TeXElementType.SectionAst : TeXElementType.Section,
      name: node.content as string,
      label: chooseCaption(node.args?.[1], node.args?.[2]),
      appendix: inAppendix,
      ...attributes
    }
  } else if (node.type === 'macro' && node.content === 'setcounter') {
    const counterName = argContentToStr(node.args?.[0]?.content ?? []).trim()
    const counterValueString = argContentToStr(node.args?.[1]?.content ?? []).trim()
    const counterValue = Number(counterValueString)
    if (
      config.secIndex[counterName] !== undefined &&
      /^[+-]?\d+$/.test(counterValueString) &&
      Number.isSafeInteger(counterValue)
    ) {
      element = {
        type: TeXElementType.SetCounter,
        name: counterName,
        label: '',
        counterValue,
        ...attributes
      }
    }
  } else if (node.type === 'macro' && config.macros.cmds.includes(node.content as string)) {
    const argStr = sanitizeLabel(node.args?.[2]?.content ?? [])
    element = {
      type: TeXElementType.Macro,
      name: node.content as string,
      label: `#${node.content}` + (argStr ? `: ${argStr}` : ''),
      ...attributes
    }
  } else if (node.type === 'macro' && node.content === 'appendix') {
    inAppendix = true
  } else if (node.type === 'environment' && node.env === 'frame') {
    const frameTitleMacro = (node.content as AstNode[]).find((sub) => sub.type === 'macro' && sub.content === 'frametitle')
    const caption = chooseCaption(node.args?.[3], frameTitleMacro?.args?.[2])
    element = {
      type: TeXElementType.Environment,
      name: node.env,
      label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` + (config.caption && caption ? `: ${caption}` : ''),
      ...attributes
    }
  } else if (
    node.type === 'environment' &&
    (((node.env === 'figure' || node.env === 'figure*') && config.macros.envs.includes('figure')) ||
      ((node.env === 'table' || node.env === 'table*') && config.macros.envs.includes('table')))
  ) {
    const captionMacro = (node.content as AstNode[]).find((sub) => sub.type === 'macro' && sub.content === 'caption')
    const caption = chooseCaption(captionMacro?.args?.[0], captionMacro?.args?.[1])
    let envName = node.env!
    if (envName.endsWith('*')) {
      envName = envName.slice(0, -1)
    }
    element = {
      type: TeXElementType.Environment,
      name: envName,
      label: `${envName.charAt(0).toUpperCase()}${envName.slice(1)}` + (config.caption && caption ? `: ${caption}` : ''),
      ...attributes
    }
  } else if (node.type === 'environment' && (node.env === 'macro' || node.env === 'environment')) {
    // DocTeX: \begin{macro}{<macro>}
    const first = (node.content as AstNode[])[0]
    const caption = typeof first?.content === 'string' ? undefined : (first?.content as AstNode[] | undefined)?.[0]
    element = {
      type: TeXElementType.Environment,
      name: node.env,
      label:
        `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` +
        (config.caption && caption ? `: ${caption.content as string}` : ''),
      ...attributes
    }
  } else if ((node.type === 'environment' || node.type === 'mathenv') && config.macros.envs.includes(node.env as string)) {
    element = {
      type: TeXElementType.Environment,
      name: node.env as string,
      label: `${(node.env as string).charAt(0).toUpperCase()}${(node.env as string).slice(1)}`,
      ...attributes
    }
  } else if (
    node.type === 'macro' &&
    ['input', 'InputIfFileExists', 'include', 'SweaveInput', 'subfile', 'subfileinclude', 'loadglsentries', 'markdownInput'].includes(
      node.content as string
    )
  ) {
    const arg0 = sanitizeInputFilePath(argContentToStr(node.args?.[0]?.content ?? []))
    const subFile = await resolveFile(
      source.fs,
      [path.dirname(filePath), path.dirname(source.rootFile ?? ''), ...config.texDirs],
      arg0
    )
    if (subFile) {
      element = {
        type: TeXElementType.SubFile,
        name: node.content as string,
        label: config.subFile ? subFile : arg0,
        ...attributes
      }
      if (config.subFile) {
        await constructFile(subFile, config, structs, source)
      }
    }
  } else if (node.type === 'macro' && ['import', 'inputfrom', 'includefrom'].includes(node.content as string)) {
    const arg0 = sanitizeInputFilePath(argContentToStr(node.args?.[0]?.content ?? []))
    const arg1 = sanitizeInputFilePath(argContentToStr(node.args?.[1]?.content ?? []))
    const subFile = await resolveFile(source.fs, [arg0, path.join(path.dirname(source.rootFile ?? ''), arg0)], arg1)
    if (subFile) {
      element = {
        type: TeXElementType.SubFile,
        name: node.content as string,
        label: config.subFile ? subFile : arg1,
        ...attributes
      }
      if (config.subFile) {
        await constructFile(subFile, config, structs, source)
      }
    }
  } else if (node.type === 'macro' && ['subimport', 'subinputfrom', 'subincludefrom'].includes(node.content as string)) {
    const arg0 = sanitizeInputFilePath(argContentToStr(node.args?.[0]?.content ?? []))
    const arg1 = sanitizeInputFilePath(argContentToStr(node.args?.[1]?.content ?? []))
    const subFile = await resolveFile(source.fs, [path.dirname(filePath)], path.join(arg0, arg1))
    if (subFile) {
      element = {
        type: TeXElementType.SubFile,
        name: node.content as string,
        label: config.subFile ? subFile : arg1,
        ...attributes
      }
      if (config.subFile) {
        await constructFile(subFile, config, structs, source)
      }
    }
  }

  if (rnwSub.length > 0 && rnwSub[rnwSub.length - 1].line >= attributes.lineFr) {
    const rnw = rnwSub.pop()
    if (rnw !== undefined) {
      root.children.push({
        type: TeXElementType.SubFile,
        name: 'RnwChild',
        label: config.subFile ? rnw.subFile : rnw.path,
        lineFr: attributes.lineFr,
        lineTo: attributes.lineTo,
        filePath,
        children: []
      })
      if (config.subFile) {
        await constructFile(rnw.subFile, config, structs, source)
      }
    }
  }

  if (element !== undefined) {
    root.children.push(element)
    root = element
  }
  if ('content' in node && typeof node.content !== 'string' && Array.isArray(node.content)) {
    for (const sub of node.content) {
      if (['string', 'parbreak', 'whitespace'].includes(sub.type)) {
        continue
      }
      inAppendix = await parseNode(sub, rnwSub, root, filePath, config, structs, inAppendix, source)
    }
  }
  return inAppendix
}

/** `insertSubFile` of the reference. */
export function insertSubFile(
  structs: Record<string, TeXElement[]>,
  rootFile: string | undefined,
  struct?: TeXElement[],
  traversed?: string[]
): TeXElement[] {
  if (rootFile === undefined) {
    return []
  }
  const source = JSON.parse(JSON.stringify(struct ?? structs[rootFile] ?? [])) as TeXElement[]
  const visited = traversed ?? [rootFile]
  let elements: TeXElement[] = []
  for (const element of source) {
    if (element.type === TeXElementType.SubFile && structs[element.label] && !visited.includes(element.label)) {
      elements = [...elements, ...insertSubFile(structs, rootFile, structs[element.label], [...visited, element.label])]
      continue
    }
    if (element.children.length > 0) {
      element.children = insertSubFile(structs, rootFile, element.children, visited)
    }
    elements.push(element)
  }
  return elements
}

/** `nestNonSection` of the reference. */
export function nestNonSection(struct: TeXElement[]): TeXElement[] {
  const elements: TeXElement[] = []
  let currentSection: TeXElement | undefined
  for (const element of struct) {
    if (element.type === TeXElementType.Section || element.type === TeXElementType.SectionAst) {
      elements.push(element)
      currentSection = element
    } else if (currentSection === undefined) {
      elements.push(element)
    } else {
      currentSection.children.push(element)
    }
    if (element.children.length > 0) {
      element.children = nestNonSection(element.children)
    }
  }
  return elements
}

/**
 * `applySectionCounters` of the reference: applies each parsed `\setcounter`
 * value to the next matching numbered section and removes the internal counter
 * elements.
 *
 * @see https://github.com/James-Yu/LaTeX-Workshop/issues/4955
 */
export function applySectionCounters(
  struct: TeXElement[],
  config: LatexStructureConfig,
  pending: Record<string, number> = {}
): TeXElement[] {
  const elements: TeXElement[] = []
  for (const element of struct) {
    const level = config.secIndex[element.name]
    if (element.type === TeXElementType.SetCounter) {
      if (level !== undefined && element.counterValue !== undefined) {
        pending[element.name] = element.counterValue
      }
      // Consume the internal marker without adding it to the visible structure.
      continue
    }
    if (element.type === TeXElementType.Section && level !== undefined && pending[element.name] !== undefined) {
      element.counterValue = pending[element.name]
      delete pending[element.name]
    }
    if (element.children.length > 0) {
      element.children = applySectionCounters(element.children, config, pending)
    }
    elements.push(element)
  }
  return elements
}

/** `nestSection` of the reference. */
export function nestSection(struct: TeXElement[], config: LatexStructureConfig): TeXElement[] {
  const stack: TeXElement[] = []
  const elements: TeXElement[] = []
  for (const element of struct) {
    if (element.type !== TeXElementType.Section && element.type !== TeXElementType.SectionAst) {
      elements.push(element)
    } else if (stack.length === 0) {
      stack.push(element)
      elements.push(element)
    } else if (config.secIndex[element.name] <= config.secIndex[stack[0].name]) {
      stack.length = 0
      stack.push(element)
      elements.push(element)
    } else if (config.secIndex[element.name] > config.secIndex[stack[stack.length - 1].name]) {
      stack[stack.length - 1].children.push(element)
      stack.push(element)
    } else {
      while (config.secIndex[element.name] <= config.secIndex[stack[stack.length - 1].name]) {
        stack.pop()
      }
      stack[stack.length - 1].children.push(element)
      stack.push(element)
    }
  }
  return elements
}

/** `fixSectionToLine` of the reference. */
export function fixSectionToLine(structure: TeXElement[], config: LatexStructureConfig, lastLine: number): void {
  const sections = structure.filter((section) => config.secIndex[section.name] !== undefined)
  sections.forEach((section) => {
    const sameFileSections = sections.filter(
      (candidate) =>
        candidate.filePath === section.filePath && candidate.lineFr >= section.lineFr && candidate !== section
    )
    if (sameFileSections.length > 0 && sameFileSections[0].lineFr === section.lineFr) {
      // On the same line, e.g., \section{one}\section{two}
      return
    } else if (sameFileSections.length > 0) {
      section.lineTo = sameFileSections[0].lineFr - 1
    } else {
      section.lineTo = lastLine
    }
    if (section.children.length > 0) {
      fixSectionToLine(section.children, config, section.lineTo)
    }
  })
}

interface FloatState {
  counter: Record<string, number>
  chapterNumber?: number
  inAppendix?: boolean
}

/** `addFloatNumber` of the reference. */
export function addFloatNumber(struct: TeXElement[], config: LatexStructureConfig, state: FloatState = { counter: {} }): TeXElement[] {
  const hierarchical = config?.documentClass === 'report' || config?.documentClass === 'book'
  for (const element of struct) {
    if (hierarchical && element.appendix && !state.inAppendix) {
      state.inAppendix = true
      state.chapterNumber = 0
      state.counter.figure = 0
      state.counter.table = 0
    }
    // report.cls and book.cls define figure/table with [chapter]. A
    // starred chapter does not advance the chapter counter and therefore
    // must not reset the float counters.
    if (hierarchical && element.type === TeXElementType.Section && element.name === 'chapter') {
      state.chapterNumber = (element.counterValue ?? state.chapterNumber ?? 0) + 1
      state.counter.figure = 0
      state.counter.table = 0
    }
    if (element.type === TeXElementType.Environment && element.name !== 'macro' && element.name !== 'environment') {
      state.counter[element.name] = (state.counter[element.name] ?? 0) + 1
      const parts = element.label.split(':')
      const chapterNumber =
        state.inAppendix && state.chapterNumber !== undefined
          ? String.fromCharCode(state.chapterNumber + 64)
          : state.chapterNumber?.toString()
      const number =
        hierarchical &&
        chapterNumber !== undefined &&
        state.chapterNumber !== undefined &&
        state.chapterNumber > 0 &&
        (element.name === 'figure' || element.name === 'table')
          ? `${chapterNumber}.${state.counter[element.name]}`
          : state.counter[element.name].toString()
      parts[0] += ` ${number}`
      element.label = parts.join(':')
    }
    if (element.children.length > 0) {
      addFloatNumber(element.children, config, state)
    }
  }
  return struct
}

/** `addSectionNumber` of the reference. */
export function addSectionNumber(
  struct: TeXElement[],
  config: LatexStructureConfig,
  tag?: string,
  lowest?: number
): TeXElement[] {
  const prefix = tag ?? ''
  const lowestLevel =
    lowest ??
    Math.min(
      ...struct.filter((element) => config.secIndex[element.name] !== undefined).map((element) => config.secIndex[element.name])
    )
  let counter: Record<number, number> = {}
  let inAppendix = false
  for (const element of struct) {
    if (element.appendix && !inAppendix) {
      inAppendix = true
      counter = {}
    }
    if (config.secIndex[element.name] === undefined) {
      continue
    }
    if (element.type === TeXElementType.Section) {
      const level = config.secIndex[element.name]
      counter[level] = (element.counterValue ?? counter[level] ?? 0) + 1
    }
    let sectionNumber =
      prefix +
      '0.'.repeat(config.secIndex[element.name] - lowestLevel) +
      (counter[config.secIndex[element.name]] ?? 0).toString()
    if (inAppendix) {
      const segments = sectionNumber.split('.')
      segments[0] = String.fromCharCode(parseInt(sectionNumber.split('.')[0]) + 64)
      sectionNumber = segments.join('.')
    }
    element.label = `${element.type === TeXElementType.Section ? sectionNumber : '*'} ${element.label}`
    if (element.children.length > 0) {
      addSectionNumber(element.children, config, sectionNumber + '.', config.secIndex[element.name] + 1)
    }
  }
  return struct
}

/** `parseRnwChildMacro` of the reference. */
export async function parseRnwChildMacro(
  content: string,
  file: string,
  rootFile: string,
  source: StructureSource
): Promise<Array<{ subFile: string; path: string; line: number }>> {
  const children: Array<{ subFile: string; path: string; line: number }> = []
  const childRegExp = new InputFileRegExp()
  for (;;) {
    const result = await childRegExp.execChild(content, file, rootFile, { fs: source.fs, settings: source.settings })
    if (!result) {
      break
    }
    const line = (content.slice(0, result.match.index).match(/\n/g) || []).length
    children.push({ subFile: result.path, path: result.match.path, line })
  }
  return children
}

/** `getChildPaths` of `outline/structure.js`. */
export function getChildPaths(section: TeXElement, paths: Set<string> = new Set<string>()): Set<string> {
  section.children.forEach((child) => {
    paths.add(child.filePath)
    getChildPaths(child, paths)
  })
  return paths
}

/** `traverseSectionTree` of `outline/structure.js` — outline-follows-editor. */
export function traverseSectionTree(sections: TeXElement[], filePath: string, lineNo: number): TeXElement | undefined {
  for (const node of sections) {
    if (
      (node.filePath === filePath && node.lineFr <= lineNo && node.lineTo >= lineNo) ||
      (node.filePath !== filePath && getChildPaths(node).has(filePath))
    ) {
      // Look for a more precise surrounding section
      return traverseSectionTree(node.children, filePath, lineNo) ?? node
    }
  }
  return undefined
}

/** Convenience: the outline commands configured for the outline view. */
export function outlineCommands(settings: LwSettings): string[] {
  return setting<string[]>(settings, 'view.outline.commands')
}
