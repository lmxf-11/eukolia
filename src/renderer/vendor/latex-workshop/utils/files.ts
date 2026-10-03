/**
 * Eukolia — LaTeX Workshop port: path & placeholder utilities.
 *
 * Ported from `out/src/utils/utils.js` (`resolveFile`, `resolveFileGlob`,
 * `getWorkingFolder`, `replaceArgumentPlaceholders`) and
 * `out/src/utils/inputfilepath.js` (`sanitizeInputFilePath`).
 *
 * The reference reaches for `vscode.workspace` and the extension's file cache;
 * here the filesystem is the injected `FileProvider` and the settings are
 * passed in, which is what keeps the ported code testable in plain Node
 * (Instructions.md §13).
 */

import path from 'path'

import { settingOr, type LwSettings } from '../settings'
import type { FileProvider } from '../types'

export function sanitizeInputFilePath(filePath: string): string {
  if (filePath.startsWith('"') && filePath.endsWith('"')) {
    return filePath.slice(1, -1)
  }
  return filePath
}

/**
 * Resolve a relative file path to an absolute path using the prefixes `dirs`.
 *
 * @param dirs An array of the paths of directories. They are used as prefixes for `inputFile`.
 * @param inputFile The path of a input file to be resolved.
 * @param suffix The suffix of the input file
 * @return an absolute path or undefined if the file does not exist
 */
export async function resolveFile(
  fs: FileProvider,
  dirs: string[],
  inputFile: string,
  suffix = '.tex'
): Promise<string | undefined> {
  const searchDirs = [...dirs]
  if (inputFile.startsWith('/')) {
    searchDirs.unshift('')
  }
  for (const d of searchDirs) {
    let inputFilePath = path.resolve(d, inputFile)
    if (path.extname(inputFilePath) === '') {
      inputFilePath += suffix
    }
    if (!(await fs.exists(inputFilePath)) && (await fs.exists(inputFilePath + suffix))) {
      inputFilePath += suffix
    }
    if (await fs.exists(inputFilePath)) {
      return inputFilePath
    }
  }
  return undefined
}

/** Synchronous twin of `resolveFile` for callers that already hold a file set. */
export function resolveFileSync(
  exists: (candidate: string) => boolean,
  dirs: string[],
  inputFile: string,
  suffix = '.tex'
): string | undefined {
  const searchDirs = [...dirs]
  if (inputFile.startsWith('/')) {
    searchDirs.unshift('')
  }
  for (const d of searchDirs) {
    let inputFilePath = path.resolve(d, inputFile)
    if (path.extname(inputFilePath) === '') {
      inputFilePath += suffix
    }
    if (!exists(inputFilePath) && exists(inputFilePath + suffix)) {
      inputFilePath += suffix
    }
    if (exists(inputFilePath)) {
      return inputFilePath
    }
  }
  return undefined
}

/**
 * Resolve a relative glob to the list of matching files. The reference uses the
 * `glob` package; Eukolia routes the query through `FileProvider.findFiles`,
 * which the Electron adapter implements with the workspace scanner.
 */
export async function resolveFileGlob(
  fs: FileProvider,
  dirs: string[],
  inputGlob: string,
  suffix = '.tex'
): Promise<string[]> {
  const searchDirs = [...dirs]
  if (inputGlob.startsWith('/')) {
    searchDirs.unshift('')
  }
  for (const d of searchDirs) {
    let inputFileGlob = path.resolve(d, inputGlob)
    if (path.extname(inputFileGlob) === '') {
      inputFileGlob += suffix
    }
    const paths = await fs.findFiles(inputFileGlob.replaceAll(path.sep, '/'))
    if (paths.length > 0) {
      return paths
    }
  }
  return []
}

/**
 * Return the working folder for a given root file, considering the
 * `latex.build.fromFolder` configuration setting.
 */
export function getWorkingFolder(rootFile: string, settings: LwSettings, workspaceDir?: string): string {
  const rootDir = path.dirname(rootFile)
  const buildFromFolder = settingOr<string>(settings, 'latex.build.fromFolder', '')
  if (buildFromFolder) {
    return workspaceDir ? path.resolve(workspaceDir, buildFromFolder) : path.resolve(rootDir, buildFromFolder)
  }
  return rootDir
}

export interface PlaceholderContext {
  rootFile: string
  tmpDir: string
  settings: LwSettings
  /** `vscode.workspace.workspaceFolders[0].uri.fsPath` in the reference. */
  workspaceDir?: string
}

/**
 * Return a function replacing placeholders of LaTeX recipes (`%DOC%`,
 * `%DOCFILE%`, `%DIR%`, `%OUTDIR%`, `%AUXDIR%`, …), ported verbatim from
 * `replaceArgumentPlaceholders` of the reference.
 */
export function replaceArgumentPlaceholders(ctx: PlaceholderContext): (arg: string) => string {
  const { rootFile, tmpDir, settings } = ctx
  const docker = settingOr<boolean>(settings, 'docker.enabled', false)
  const workspaceDir = (ctx.workspaceDir ?? '').split(path.sep).join('/')
  const rootFileParsed = path.parse(rootFile)
  const docfile = rootFileParsed.name
  const docfileExt = rootFileParsed.base
  const dirW32 = path.normalize(rootFileParsed.dir)
  const dir = dirW32.split(path.sep).join('/')
  const docW32 = path.join(dirW32, docfile)
  const doc = docW32.split(path.sep).join('/')
  const docExtW32 = path.join(dirW32, docfileExt)
  const docExt = docExtW32.split(path.sep).join('/')
  const relativeWorkspaceDir = path.relative(workspaceDir, dir).split(path.sep).join('/')
  const relativeWorkspaceDoc = path.relative(workspaceDir, doc).split(path.sep).join('/')
  const workingFolder = getWorkingFolder(rootFile, settings, ctx.workspaceDir)
  const relativeWorkingDir = path.relative(workingFolder, dir).split(path.sep).join('/')
  const relativeWorkingDoc = path.relative(workingFolder, doc).split(path.sep).join('/')
  const expandPlaceHolders = (a: string): string => {
    return a
      .replace(/%DOC%/g, docker ? docfile : doc)
      .replace(/%DOC_W32%/g, docker ? docfile : docW32)
      .replace(/%DOC_EXT%/g, docker ? docfileExt : docExt)
      .replace(/%DOC_EXT_W32%/g, docker ? docfileExt : docExtW32)
      .replace(/%DOCFILE_EXT%/g, docfileExt)
      .replace(/%DOCFILE%/g, docfile)
      .replace(/%DIR%/g, docker ? './' : dir)
      .replace(/%DIR_W32%/g, docker ? './' : dirW32)
      .replace(/%TMPDIR%/g, tmpDir)
      .replace(/%WORKSPACE_FOLDER%/g, docker ? './' : workspaceDir)
      .replace(/%RELATIVE_DIR%/, docker ? './' : relativeWorkspaceDir)
      .replace(/%RELATIVE_DOC%/, docker ? docfile : relativeWorkspaceDoc)
      .replace(/%RELATIVE_CWD_DIR%/, docker ? './' : relativeWorkingDir)
      .replace(/%RELATIVE_CWD_DOC%/, docker ? docfile : relativeWorkingDoc)
  }
  const outDirW32 = path.normalize(expandPlaceHolders(settingOr<string>(settings, 'latex.outDir', '%DIR%')))
  const outDir = outDirW32.split(path.sep).join('/')
  const auxDir = path
    .normalize(expandPlaceHolders(settingOr<string>(settings, 'latex.auxDir', '%OUTDIR%')))
    .split(path.sep)
    .join('/')
  // Replace %AUXDIR% first as its default value is %OUTDIR%
  return (arg: string): string =>
    expandPlaceHolders(arg).replace(/%AUXDIR%/g, auxDir).replace(/%OUTDIR%/g, outDir).replace(/%OUTDIR_W32%/g, outDirW32)
}
