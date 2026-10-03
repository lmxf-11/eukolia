/**
 * Eukolia — LaTeX Workshop port: file-name completion
 * (`\input`, `\include`, `\includegraphics`, `\import`, `\subimport`, ...).
 *
 * Ported from `out/src/completion/completer/input.js` of LaTeX Workshop 10.19.0:
 * `InputAbstract.from`/`provide`/`filterIgnoredFiles` plus the `Input`, `Import`
 * and `SubImport` subclasses with their `provideDirOnly`/`getBaseDir`.
 *
 * Adaptations required by the port:
 *  - the reference lists directories with `fs.readdirSync`/`fs.lstatSync`.
 *    Eukolia has no renderer filesystem, so the listing is derived from
 *    `CompletionProjectState.files()`, which is the project's file index. The
 *    completion is therefore limited to files that belong to the project;
 *  - `CompletionProjectState.graphicsPaths(uri)` already returns the absolute
 *    `\graphicspath` directories (`lw.completion.input.parseGraphicsPath` plus
 *    the root directory in the reference), so `parseGraphicsPath`/`reset` are not
 *    ported;
 *  - VS Code's `files.exclude` is not available; only
 *    `intellisense.file.exclude` and the reference's fixed ignore list apply;
 *  - `lw.root.dir.path` (the root file's directory) is not part of
 *    `CompletionProjectState`; an adapter may add `rootFile(uri)`, and the
 *    current file's directory is used otherwise. Relative base directories and
 *    the `'/'` base of `Import` resolve against that directory instead of the
 *    editor process' working directory;
 *  - the item `detail` is the resolved directory (the reference's value depends
 *    on the working directory, so it is not reproducible).
 */

import path from 'path'

import { globMatches } from '../fs/glob'
import { textPosition, uriToPath, withTextEdit } from './completerUtils'
import {
  CompletionItemKind,
  type CompletionContext,
  type CompletionProjectState,
  type CompletionTextRange,
  type LatexCompletionItem
} from './types'
import { settingOr } from '../settings'

const ignoreFiles = ['**/.vscode', '**/.vscodeignore', '**/.gitignore']

/** `latex-workshop.intellisense.file.exclude`'s default, from the reference `package.json`. */
const defaultFileExclude = [
  '**/*.aux',
  '**/*.bbl',
  '**/*.bcf',
  '**/*.blg',
  '**/*.idx',
  '**/*.ind',
  '**/*.lof',
  '**/*.lot',
  '**/*.out',
  '**/*.toc',
  '**/*.acn',
  '**/*.acr',
  '**/*.alg',
  '**/*.glg',
  '**/*.glo',
  '**/*.gls',
  '**/*.ist',
  '**/*.fls',
  '**/*.log',
  '**/*.nav',
  '**/*.snm',
  '**/*.fdb_latexmk',
  '**/*.synctex.gz',
  '**/*.run.xml'
]

/**
 * `lw.root.dir.path` of the reference. The adapter may expose the root file as
 * `rootFile(uri)`; the current file's own directory is the fallback, which is
 * what the reference resolves for a single-file project.
 */
function projectRootDir(context: CompletionContext): string {
  const project = context.project as CompletionProjectState & { rootFile?(uri: string): string | undefined }
  const uri = context.args.uri
  const rootFile = project.rootFile?.(uri)
  return path.dirname(rootFile ?? uriToPath(uri))
}

/** The reference resolves directories against the working folder; here, the project root. */
function resolveDir(dir: string, context: CompletionContext): string {
  return path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(projectRootDir(context), dir)
}

abstract class InputAbstract {
  /**
   * Filter a list of completion paths
   *
   * @param files The list of file names in `baseDir`
   * @param baseDir The base directory to resolve paths from
   */
  protected filterIgnoredFiles(files: string[], baseDir: string, context: CompletionContext): string[] {
    const excludeGlob = (
      settingOr<string[]>(context.args.settings, 'intellisense.file.exclude', defaultFileExclude) || []
    ).concat(ignoreFiles)
    return files.filter((file) => {
      const filePath = path.resolve(baseDir, file)
      return !excludeGlob.some((glob) => globMatches(glob, filePath))
    })
  }

  from(result: RegExpMatchArray, context: CompletionContext): LatexCompletionItem[] {
    const macro = result[1]
    const payload = [...result.slice(2).reverse()]
    return this.provide(context, macro, payload)
  }

  /**
   * Provide file name intellisense
   *
   * @param payload an array of string
   *      payload[0]: The already typed path
   *      payload[1]: The path from which completion is triggered, may be empty
   */
  protected provide(context: CompletionContext, macro: string, payload: Array<string | undefined>): LatexCompletionItem[] {
    const currentFile = uriToPath(context.args.uri)
    const line = context.args.line
    const character = context.args.character
    const position = textPosition(context.args)
    const typedFolder = payload[0] ?? ''
    const importFromDir = payload[1]
    const startPos = Math.max(line.lastIndexOf('{', character), line.lastIndexOf('/', character))
    const range: CompletionTextRange | undefined =
      startPos >= 0
        ? {
            start: { line: position.line, character: startPos + 1 },
            end: { line: position.line, character }
          }
        : undefined
    const baseDir = this.getBaseDir(currentFile, importFromDir, macro, context)
    const provideDirOnly = this.provideDirOnly(importFromDir)
    const settings = context.args.settings
    const suggestions: LatexCompletionItem[] = []
    baseDir.forEach((base) => {
      // `Import` without a base directory lists the filesystem root; the project
      // drive stands in for the editor process' working drive.
      let absoluteRoot = base === '/'
      let dir = absoluteRoot ? path.parse(projectRootDir(context)).root : resolveDir(base, context)
      if (typedFolder !== '') {
        let currentFolder = typedFolder
        if (!typedFolder.endsWith('/')) {
          currentFolder = path.dirname(typedFolder)
        }
        dir = path.resolve(dir, currentFolder)
        absoluteRoot = false
      }
      let files: string[]
      try {
        files = this.filterIgnoredFiles(this.readDirectory(dir, context), dir, context)
      } catch (err) {
        // The reference wraps `fs.readdirSync` the same way: one unreadable
        // directory must not take the whole completion request down.
        console.warn(`Error reading directory ${dir} .`, err)
        return
      }
      files.forEach((file) => {
        const filePath = path.resolve(dir, file)
        if (absoluteRoot) {
          // Keep the leading '/' to have an absolute path
          file = '/' + file
        }
        if (this.isDirectory(filePath, context)) {
          const item: LatexCompletionItem = {
            label: `${file}/`,
            kind: CompletionItemKind.Folder,
            command: { title: 'Post-Action', command: 'editor.action.triggerSuggest' },
            detail: dir
          }
          suggestions.push(withTextEdit(item, range))
        } else if (!provideDirOnly) {
          const preview = settingOr<boolean>(settings, 'intellisense.includegraphics.preview.enabled', true)
          const item: LatexCompletionItem = {
            label: file,
            kind: CompletionItemKind.File,
            detail: dir
          }
          if (preview && ['includegraphics', 'includesvg'].includes(macro)) {
            item.documentation = filePath
          }
          if (['include', 'includeonly', 'excludeonly'].includes(macro)) {
            item.insertText = path.parse(file).name
          }
          suggestions.push(withTextEdit(item, range))
        }
      })
    })
    return suggestions
  }

  /** `fs.readdirSync(dir)`: the project files that are direct children of `dir`. */
  private readDirectory(dir: string, context: CompletionContext): string[] {
    const resolved = path.resolve(dir)
    const names: string[] = []
    for (const entry of context.project.files()) {
      if (path.resolve(path.dirname(path.resolve(entry.path))) !== resolved) {
        continue
      }
      if (!names.includes(entry.name)) {
        names.push(entry.name)
      }
    }
    return names
  }

  /** `fs.lstatSync(filePath).isDirectory()`. */
  private isDirectory(filePath: string, context: CompletionContext): boolean {
    const resolved = path.resolve(filePath)
    return context.project.files().some((entry) => entry.isDirectory && path.resolve(entry.path) === resolved)
  }

  protected abstract provideDirOnly(importFromDir: string | undefined): boolean

  protected abstract getBaseDir(
    currentFile: string,
    importFromDir: string | undefined,
    macro: string,
    context: CompletionContext
  ): string[]
}

class Input extends InputAbstract {
  protected provideDirOnly(_importFromDir: string | undefined): boolean {
    return false
  }

  protected getBaseDir(
    currentFile: string,
    _importFromDir: string | undefined,
    macro: string,
    context: CompletionContext
  ): string[] {
    const rootDir = projectRootDir(context)
    if (rootDir === undefined) {
      console.warn(`No root dir can be found. The current root file should be undefined, is ${currentFile}. How did you get here?`)
      return []
    }
    // If there is no root, 'root relative' and 'both' should fall back to 'file relative'
    if (['includegraphics', 'includesvg'].includes(macro)) {
      const graphicsPath = context.project.graphicsPaths(context.args.uri)
      if (graphicsPath.length > 0) {
        return graphicsPath
      }
    }
    const baseConfig = settingOr<string>(context.args.settings, 'intellisense.file.base', 'root relative')
    const baseDirCurrentFile = path.dirname(currentFile)
    switch (baseConfig) {
      case 'root relative':
        return [rootDir]
      case 'file relative':
        return [baseDirCurrentFile]
      case 'both':
        if (baseDirCurrentFile !== rootDir) {
          return [baseDirCurrentFile, rootDir]
        }
        return [rootDir]
      default:
        return []
    }
  }
}

class Import extends InputAbstract {
  protected provideDirOnly(importFromDir: string | undefined): boolean {
    return !importFromDir
  }

  protected getBaseDir(
    _currentFile: string,
    importFromDir: string | undefined,
    _macro: string,
    _context: CompletionContext
  ): string[] {
    if (importFromDir) {
      return [importFromDir]
    }
    return ['/']
  }
}

class SubImport extends InputAbstract {
  protected provideDirOnly(importFromDir: string | undefined): boolean {
    return !importFromDir
  }

  protected getBaseDir(
    currentFile: string,
    importFromDir: string | undefined,
    _macro: string,
    _context: CompletionContext
  ): string[] {
    if (importFromDir) {
      return [path.join(path.dirname(currentFile), importFromDir)]
    }
    return [path.dirname(currentFile)]
  }
}

export const input = new Input()
export const inputProvider = input
const importMacro = new Import()
const subimportMacro = new SubImport()
export const importProvider = importMacro
export const subimportProvider = subimportMacro
