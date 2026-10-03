#!/usr/bin/env node
/**
 * Build the Eukolia native PDF worker: resources/native/eukolia-pdf.exe
 *
 * This is the primary build path because CMake does not reliably locate the
 * Strawberry Perl MinGW toolchain that ships g++/gendef/dlltool. It shells out
 * directly, which is the path that is known to work here.
 *
 * The worker links the vendored MuPDF runtime (resources/native/libmupdf.dll).
 * That DLL is an MSVC build, so a MinGW import library is generated once with
 * `gendef` + `dlltool` and reused afterwards. Both steps are idempotent.
 *
 * Usage:
 *   node scripts/build-native-pdf.mjs              # build (skips when up to date)
 *   node scripts/build-native-pdf.mjs --force      # rebuild regardless
 *   node scripts/build-native-pdf.mjs --vendor     # (re)vendor DLL + headers
 *   node scripts/build-native-pdf.mjs --clean      # remove build artefacts first
 *   node scripts/build-native-pdf.mjs --cmake      # use CMake instead of g++
 *
 * Exit codes: 0 on success, 1 on any failure (the compiler's stderr is printed).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const NATIVE_DIR = path.join(ROOT, 'resources', 'native');
const SRC_DIR = path.join(ROOT, 'src', 'native', 'pdf');
// Intermediate objects live under the source tree rather than at the workspace
// root, so building does not clutter the project explorer.
const BUILD_DIR = path.join(ROOT, 'src', 'native', 'pdf', '.build');

const DLL_NAME = 'libmupdf.dll';
const DLL_PATH = path.join(NATIVE_DIR, DLL_NAME);
const DEF_PATH = path.join(BUILD_DIR, 'libmupdf.def');
const IMPORT_LIB = path.join(BUILD_DIR, `${DLL_NAME.replace(/\.dll$/, '.a')}`);
const RSP_PATH = path.join(BUILD_DIR, 'objects.rsp');
const EXE_PATH = path.join(NATIVE_DIR, 'eukolia-pdf.exe');

const SOURCES = ['protocol.cpp', 'mupdf_engine.cpp', 'render_cache.cpp', 'worker_main.cpp'];

const LIGHTPDF_DIR = path.join(SRC_DIR, 'lightpdf');

/**
 * The vendored light-pdf translation units (see src/native/pdf/lightpdf/PORTING.md).
 *
 * These are the reference project's own sources, compiled unchanged: its string,
 * container and geometry base library, its EngineBase/DocProperties/TreeModel
 * support code, and -- the point of the exercise -- TextSelection.cpp,
 * TextSearch.cpp, DocumentLayout.cpp and DisplayMode.cpp, which are the real
 * implementation of text selection, text search and page layout in this worker.
 * engine_mupdf_adapter.cpp is the only new file: the seam that implements
 * light-pdf's EngineBase on top of the worker's mupdf layer.
 */
const LIGHTPDF_SOURCES = [
  'CrashHandlerNoOp.cpp',
  'DisplayMode.cpp',
  'DocProperties.cpp',
  'DocumentLayout.cpp',
  'EngineBase.cpp',
  'TextSearch.cpp',
  'TextSelection.cpp',
  'TreeModel.cpp',
  'engine_mupdf_adapter.cpp',
  'eukolia_base_io_compat.cpp',
  'base/Arena.cpp',
  'base/Arena_win.cpp',
  'base/Base.cpp',
  'base/Base_win.cpp',
  'base/Color.cpp',
  'base/Geom.cpp',
  'base/LogNoOp.cpp',
  'base/Str.cpp',
  'base/StrFormatParse.cpp',
  'base/StrUtf8.cpp',
  'base/StrVec.cpp',
  'base/Strconv.cpp',
  'base/Thread.cpp'
];

/**
 * The part of light-pdf's base library this worker does not vendor.
 *
 * light-pdf's file and path layer (base/File.cpp, base/File_win.cpp,
 * base/WinDynCalls_win.cpp) is not copied: its Windows implementation sits on
 * base/Win.cpp -- ~130 KB of registry, DDE, printing, clipboard and shell code a
 * headless PDF worker must not carry, and which does not compile outside
 * light-pdf's own MSVC build configuration (it needs the Windows SDK's ddeml.h /
 * winspool.h and a UNICODE build). Three functions from that layer are still
 * reachable -- file::WriteFile(), file::Copy() and path::GetExtTemp() -- and live
 * in lightpdf/eukolia_base_io_compat.cpp instead, implemented with the same Win32
 * calls light-pdf uses. See src/native/pdf/lightpdf/PORTING.md.
 */

/**
 * SDK gaps in MinGW-w64 13.2 that light-pdf's unmodified headers reference
 * (`SetThreadDescription`, the Windows 11 DWM constants). Force-included ahead of
 * every light-pdf translation unit so none of the vendored files has to change.
 */
const LIGHTPDF_FORCE_INCLUDE = path.join(LIGHTPDF_DIR, 'eukolia_win32_compat.h');

/**
 * Warning classes raised by the vendored light-pdf sources under GCC 13 that do
 * not exist (or do not fire) in the MSVC build light-pdf is developed with. They
 * are switched off for those translation units only, so the worker's own sources
 * keep the full -Wall -Wextra set:
 *
 *   -Wcast-function-type  GetProcAddress() results cast to their real signature
 *                         (base/WinDynCalls_win.cpp).
 *   -Wclass-memaccess     Vec<> zeroes elements with memset, which GCC 13 flags
 *                         for any element type with a default member initializer.
 *   -Wsign-compare        base/StrFormatParse.cpp's format parser.
 *   -Wtype-limits         EngineBase.cpp compares an unsigned against 0.
 *   -Wunused-variable /
 *   -Wunused-but-set-variable  EngineBase.cpp's `pt`, TextSelection.cpp's `text`.
 *   -Wswitch              DisplayMode.cpp's IsContinuous() intentionally handles
 *                         only the continuous modes.
 */
const LIGHTPDF_WARNING_FLAGS = [
  '-Wno-cast-function-type',
  '-Wno-class-memaccess',
  '-Wno-sign-compare',
  '-Wno-type-limits',
  '-Wno-unused-variable',
  '-Wno-unused-but-set-variable',
  '-Wno-switch',
  '-Wno-nonnull-compare',
  '-Wno-implicit-fallthrough'
];

/**
 * The subset of the above that also has to apply to worker_main.cpp, because
 * that file includes light-pdf's base headers (through the EngineBase seam
 * header) and therefore instantiates them in its own translation unit. Without
 * these the worker's main TU reports warnings that originate entirely in
 * vendored code:
 *
 *   -Wunknown-pragmas  base/Base.h wraps <gdiplus.h> in MSVC `#pragma warning`.
 *   -Wclass-memaccess  Vec<>'s memset, instantiated for Rect/DocumentLayoutPage.
 *   -Wcast-function-type  base/Base.h's Func1<T> trampoline.
 *
 * The worker's other translation units keep the full warning set.
 */
const LIGHTPDF_HEADER_WARNING_FLAGS = [
  '-Wno-unknown-pragmas',
  '-Wno-class-memaccess',
  '-Wno-cast-function-type'
];


/** Where the reference checkout lives. Only used by --vendor / first-time setup. */
const REFERENCE_ROOT = path.join(ROOT, 'References', 'light-pdf');

const args = new Set(process.argv.slice(2));
const force = args.has('--force') || args.has('--clean');
const useCmake = args.has('--cmake');

function log(message) {
  process.stdout.write(`[build:native] ${message}\n`);
}

/** Blocking sleep; the build script is synchronous by design. */
function sleep(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * Kill any running eukolia-pdf.exe.
 *
 * The worker is always a throwaway child of a test or a dev run, and Windows
 * holds a lock on its image for as long as it lives -- which is the only reason
 * a rebuild ever fails to write the executable.
 */
function terminateStaleWorkers() {
  if (process.platform !== 'win32') return;
  spawnSync('taskkill', ['/F', '/IM', 'eukolia-pdf.exe'], { stdio: 'ignore', windowsHide: true });
}

function fail(message, detail) {
  process.stderr.write(`\n[build:native] FAILED: ${message}\n`);
  if (detail) process.stderr.write(`${detail}\n`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
  if (result.error) {
    return { ok: false, status: -1, stdout: '', stderr: String(result.error.message ?? result.error) };
  }
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

/** Resolve a tool on PATH, failing with an actionable message. */
function which(tool) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [tool], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return null;
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

function requireTool(tool, hint) {
  const found = which(tool);
  if (!found) {
    fail(
      `required tool "${tool}" was not found on PATH`,
      hint ? `  ${hint}` : undefined
    );
  }
  return found;
}

function newestMtime(paths) {
  let newest = 0;
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // Missing inputs count as "infinitely new" so the caller rebuilds.
      return Number.POSITIVE_INFINITY;
    }
  }
  return newest;
}

function listFiles(dir, predicate, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vendoring: copy the runtime and headers out of References/ so Eukolia builds
// and runs without that directory (Instructions.md §8).
// ---------------------------------------------------------------------------

function vendor() {
  const mupdfRoot = path.join(REFERENCE_ROOT, 'mupdf');
  const sourceDll = path.join(REFERENCE_ROOT, 'out', 'dbg64', DLL_NAME);
  const headerSource = path.join(mupdfRoot, 'include');
  const headerTarget = path.join(SRC_DIR, 'third_party', 'mupdf', 'include');

  fs.mkdirSync(NATIVE_DIR, { recursive: true });
  fs.mkdirSync(headerTarget, { recursive: true });

  if (fs.existsSync(sourceDll)) {
    fs.copyFileSync(sourceDll, DLL_PATH);
    log(`vendored ${path.relative(ROOT, DLL_PATH)} (${(fs.statSync(DLL_PATH).size / 1048576).toFixed(1)} MB)`);
  } else if (!fs.existsSync(DLL_PATH)) {
    fail(
      `no vendored ${DLL_NAME} and no reference copy at ${sourceDll}`,
      '  Set up References/light-pdf or place a libmupdf.dll in resources/native/.'
    );
  }

  if (fs.existsSync(headerSource)) {
    fs.cpSync(headerSource, headerTarget, { recursive: true });
    const count = listFiles(headerTarget, () => true).length;
    log(`vendored ${count} MuPDF headers into ${path.relative(ROOT, headerTarget)}`);
  } else if (listFiles(headerTarget, () => true).length === 0) {
    fail(`no vendored MuPDF headers and no reference copy at ${headerSource}`);
  }

  // Licence / notice files: preserved alongside the runtime.
  const notices = [
    ['COPYING', 'light-pdf-COPYING.txt'],
    ['COPYING.BSD', 'light-pdf-COPYING.BSD.txt'],
    ['AUTHORS', 'light-pdf-AUTHORS.txt']
  ];
  for (const [source, target] of notices) {
    const from = path.join(REFERENCE_ROOT, source);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(NATIVE_DIR, target));
    }
  }
  const mupdfCopying = path.join(mupdfRoot, 'COPYING');
  if (fs.existsSync(mupdfCopying)) {
    fs.copyFileSync(mupdfCopying, path.join(NATIVE_DIR, 'mupdf-COPYING.txt'));
  }
  log('runtime and notices vendored');
}

// ---------------------------------------------------------------------------
// Import library: gendef + dlltool
// ---------------------------------------------------------------------------

function ensureImportLibrary() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  if (fs.existsSync(IMPORT_LIB) && !force) {
    const libTime = fs.statSync(IMPORT_LIB).mtimeMs;
    if (libTime >= fs.statSync(DLL_PATH).mtimeMs) {
      return IMPORT_LIB;
    }
  }

  const gendef = requireTool('gendef', 'Install MinGW-w64 (Strawberry Perl ships it at C:\\Strawberry\\c\\bin).');
  const dlltool = requireTool('dlltool', 'Install MinGW-w64 (Strawberry Perl ships it at C:\\Strawberry\\c\\bin).');

  // gendef must run where the DLL is, because it resolves the module by name.
  const gendefResult = run(gendef, ['-', DLL_NAME], { cwd: NATIVE_DIR, capture: true });
  if (!gendefResult.ok || !gendefResult.stdout.includes('EXPORTS')) {
    fail('gendef failed to produce a definition file', gendefResult.stderr || gendefResult.stdout);
  }
  fs.writeFileSync(DEF_PATH, gendefResult.stdout);

  const exportCount = gendefResult.stdout
    .split(/\r?\n/)
    .filter((line) => /^\S/.test(line) && !/^(LIBRARY|EXPORTS|;)/.test(line)).length;
  log(`gendef: ${exportCount} exported symbols`);
  if (exportCount < 100) {
    fail(`only ${exportCount} exports found -- the DLL looks wrong or truncated`);
  }

  const dlltoolResult = run(
    dlltool,
    ['-d', DEF_PATH, '-l', IMPORT_LIB, '-D', DLL_NAME],
    { capture: true }
  );
  if (!dlltoolResult.ok || !fs.existsSync(IMPORT_LIB)) {
    fail('dlltool failed to build the import library', dlltoolResult.stderr || dlltoolResult.stdout);
  }
  log(`import library: ${path.relative(ROOT, IMPORT_LIB)}`);
  return IMPORT_LIB;
}

// ---------------------------------------------------------------------------
// Direct g++ build
// ---------------------------------------------------------------------------

function buildWithGpp() {
  const gpp = requireTool('g++', 'Install MinGW-w64 (Strawberry Perl ships it at C:\\Strawberry\\c\\bin).');
  const importLib = ensureImportLibrary();
  const includeDir = path.join(SRC_DIR, 'third_party', 'mupdf', 'include');
  const localInclude = path.join(SRC_DIR, 'src');

  if (!fs.existsSync(path.join(includeDir, 'mupdf', 'fitz.h'))) {
    fail(`vendored MuPDF headers missing at ${includeDir}`, '  Run: node scripts/build-native-pdf.mjs --vendor');
  }

  const sources = SOURCES.map((name) => path.join(localInclude, name));
  for (const source of sources) {
    if (!fs.existsSync(source)) fail(`missing source file ${source}`);
  }
  if (!fs.existsSync(LIGHTPDF_DIR)) {
    fail(`vendored light-pdf sources missing at ${LIGHTPDF_DIR}`, '  See src/native/pdf/lightpdf/PORTING.md');
  }
  // The vendored light-pdf translation units. They are compiled with the same
  // toolchain but with the light-pdf include root on the path (so `#include
  // "base/Base.h"` resolves the way the reference sources expect), the SDK-gap
  // shim force-included, and the vendored-code warning set.
  const lightpdfSources = LIGHTPDF_SOURCES.map((name) => path.join(LIGHTPDF_DIR, name));
  for (const source of lightpdfSources) {
    if (!fs.existsSync(source)) fail(`missing vendored light-pdf source ${source}`);
  }

  const exeMtime = fs.existsSync(EXE_PATH) ? fs.statSync(EXE_PATH).mtimeMs : 0;
  const inputMtime = Math.max(
    newestMtime([...sources, ...lightpdfSources]),
    newestMtime(listFiles(localInclude, (f) => f.endsWith('.h'))),
    newestMtime(listFiles(LIGHTPDF_DIR, (f) => f.endsWith('.h'))),
    newestMtime([importLib, path.join(SRC_DIR, 'CMakeLists.txt')])
  );
  if (!force && exeMtime > inputMtime) {
    log(`up to date: ${path.relative(ROOT, EXE_PATH)} (use --force to rebuild)`);
    return;
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const objects = [];
  const commonFlags = [
    '-std=c++17',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Wno-unused-parameter',
    '-DNOMINMAX',
    '-DWIN32_LEAN_AND_MEAN',
    '-D_WIN32_WINNT=0x0601',
    `-I${localInclude}`,
    // worker_main.cpp includes the light-pdf seam header from here. None of the
    // light-pdf headers shadows a worker header (verified by name), and the
    // vendored sources still resolve their own quoted includes from their own
    // directory first.
    `-I${LIGHTPDF_DIR}`,
    `-I${includeDir}`
  ];
  const lightpdfFlags = [
    '-Wno-unknown-pragmas',
    '-include',
    LIGHTPDF_FORCE_INCLUDE,
    ...LIGHTPDF_WARNING_FLAGS
  ];

  const translationUnits = [
    ...sources.map((source) => ({
      source,
      // Only worker_main.cpp includes the light-pdf headers.
      flags: path.basename(source) === 'worker_main.cpp'
        ? [...commonFlags, ...LIGHTPDF_HEADER_WARNING_FLAGS]
        : commonFlags
    })),
    ...lightpdfSources.map((source) => ({ source, flags: [...commonFlags, ...lightpdfFlags] }))
  ];

  log(`compiling ${translationUnits.length} translation units with ${gpp}`);
  for (const { source, flags } of translationUnits) {
    const object = path.join(BUILD_DIR, `${path.basename(source, '.cpp')}.o`);
    const objectMtime = fs.existsSync(object) ? fs.statSync(object).mtimeMs : 0;
    const headerMtime = Math.max(
      newestMtime([source]),
      newestMtime(listFiles(localInclude, (f) => f.endsWith('.h'))),
      flags.includes(`-include`) ? newestMtime(listFiles(LIGHTPDF_DIR, (f) => f.endsWith('.h'))) : 0
    );
    if (!force && objectMtime > headerMtime) {
      objects.push(object);
      continue;
    }
    const result = run(gpp, [...flags, '-c', source, '-o', object]);
    if (!result.ok) {
      fail(`compiling ${path.basename(source)} failed`, result.stderr);
    }
    objects.push(object);
  }

  // Response file keeps the link line short and avoids any shell quoting issues
  // with the absolute paths involved. Forward slashes are required: gcc's
  // response-file reader treats backslashes as escapes and would eat the
  // separators.
  const toPosix = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(RSP_PATH, objects.map((o) => `"${toPosix(o)}"`).join('\n'));

  const linkArgs = [
    '-o',
    toPosix(EXE_PATH),
    `@${toPosix(RSP_PATH)}`,
    '-L',
    toPosix(path.dirname(importLib)),
    '-lmupdf',
    '-static-libgcc',
    '-static-libstdc++',
    '-static'
  ];

  // Windows keeps the image locked while a worker process is still running, so a
  // rebuild straight after a test run or a crashed app hits "cannot open output
  // file ... Permission denied". Kill any lingering worker first -- it is always a
  // throwaway child of a test or a dev run -- then retry.
  //
  // The linker's stderr is CAPTURED rather than inherited: the lock message has to
  // be inspected to decide whether to retry. It is echoed on failure, so the
  // compiler diagnostics still reach the terminal.
  terminateStaleWorkers();
  log('linking');
  const isLockError = (text) =>
    /cannot open output file|permission denied|being used by another process|text file busy/i.test(text ?? '');
  let linkResult = run(gpp, linkArgs, { capture: true });
  for (let attempt = 1; attempt <= 15 && !linkResult.ok; attempt++) {
    if (!isLockError(linkResult.stderr)) break;
    log(`output file is locked (attempt ${attempt}/15); waiting for the running worker to exit`);
    sleep(1000);
    terminateStaleWorkers();
    linkResult = run(gpp, linkArgs, { capture: true });
  }
  if (!linkResult.ok) {
    if (linkResult.stdout) process.stdout.write(linkResult.stdout);
    fail(
      'linking failed',
      isLockError(linkResult.stderr)
        ? `${linkResult.stderr}\n  A eukolia-pdf.exe process is still running. Stop the app, or run\n    taskkill /F /IM eukolia-pdf.exe\n  and retry.`
        : linkResult.stderr
    );
  }
  if (!fs.existsSync(EXE_PATH)) {
    fail(`the linker reported success but ${EXE_PATH} does not exist`);
  }
  log(`built ${path.relative(ROOT, EXE_PATH)} (${(fs.statSync(EXE_PATH).size / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// CMake build
// ---------------------------------------------------------------------------

function buildWithCmake() {
  const cmake = requireTool('cmake', 'Install CMake.');
  ensureImportLibrary();
  const cmakeBuild = path.join(BUILD_DIR, 'cmake');
  fs.mkdirSync(cmakeBuild, { recursive: true });

  log('configuring with CMake (MinGW Makefiles)');
  const configure = run(cmake, ['-S', SRC_DIR, '-B', cmakeBuild, '-G', 'MinGW Makefiles', '-DCMAKE_BUILD_TYPE=Release'], {
    capture: true
  });
  if (!configure.ok) {
    fail('CMake configure failed', `${configure.stdout}\n${configure.stderr}`);
  }
  log('building with CMake');
  const build = run(cmake, ['--build', cmakeBuild, '--config', 'Release'], { capture: true });
  if (!build.ok) {
    fail('CMake build failed', `${build.stdout}\n${build.stderr}`);
  }
  if (!fs.existsSync(EXE_PATH)) {
    fail(`CMake reported success but ${EXE_PATH} does not exist`);
  }
  log(`built ${path.relative(ROOT, EXE_PATH)}`);
}

// ---------------------------------------------------------------------------

function clean() {
  // A running worker holds its own image open, and Windows refuses to unlink a
  // mapped executable. That is a normal situation (a test or dev run left one
  // behind), not a reason to abort, so stop them first and tolerate a failure:
  // the linker will replace the file anyway.
  terminateStaleWorkers();
  if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    log(`removed ${path.relative(ROOT, BUILD_DIR)}`);
  }
  if (fs.existsSync(EXE_PATH)) {
    try {
      fs.rmSync(EXE_PATH, { force: true });
      log(`removed ${path.relative(ROOT, EXE_PATH)}`);
    } catch (error) {
      log(`could not remove ${path.relative(ROOT, EXE_PATH)} yet (${error.code ?? 'busy'}); it will be overwritten`);
    }
  }
}

function main() {
  if (args.has('--clean')) clean();
  if (args.has('--vendor') || !fs.existsSync(DLL_PATH)) vendor();

  if (!fs.existsSync(DLL_PATH)) {
    fail(`${path.relative(ROOT, DLL_PATH)} is missing`, '  Run: node scripts/build-native-pdf.mjs --vendor');
  }
  if (!fs.existsSync(EXE_PATH) && !fs.existsSync(BUILD_DIR)) {
    // First run: make sure the headers are present too.
    const headerDir = path.join(SRC_DIR, 'third_party', 'mupdf', 'include', 'mupdf');
    if (!fs.existsSync(headerDir)) vendor();
  }

  if (useCmake) {
    buildWithCmake();
  } else {
    buildWithGpp();
  }
}

main();
