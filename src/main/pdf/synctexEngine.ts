/**
 * SyncTeX engine (Electron main process).
 *
 * Drives MiKTeX's `synctex.exe`, the same approach LaTeX Workshop takes
 * (`References/james-yu.latex-workshop-10.19.0/out/src/locate/synctex.js`):
 *
 *   forward  source -> PDF : synctex view -i <line>:0:<abs .tex> -o <abs pdf>
 *   inverse  PDF -> source : synctex edit -o <page>:<x>:<y>:<abs pdf>
 *
 * The behaviour below was established by probing MiKTeX's SyncTeX 1.5 client
 * ("Synchronize TeXnology command-line client, version 1.21") directly, not
 * assumed:
 *
 *  - `-i` is a **tag lookup**, not a file lookup. It must be given the exact
 *    absolute path TeX recorded (case-insensitive, `/` and `\` interchangeable,
 *    a `.` segment tolerated; a basename, `./file`, `..` or a doubled separator
 *    all fail with `SyncTeX Warning: No tag for ...`).
 *  - `-o` is `PAGE:X:Y:FILE`. `:` is the only separator; a comma is a hard
 *    `Bad -o argument` error.
 *  - Option order is positional: `-i` then `-o`, and `-d` only after `-o`.
 *  - `-i`'s column field is ignored entirely by this client, but omitting it is a
 *    hard error, so 0 is always passed.
 *  - Both directions use **PDF points (bp), origin top-left**, which is the same
 *    space the native PDF worker reports, so no flipping is needed.
 *  - Everything a parser needs is on **stdout**; stderr carries only the
 *    `SyncTeX ERROR:` line plus a usage block.
 *  - Exit codes cannot be trusted: a missing PDF, "no tag" and out-of-range pages
 *    all exit 0, and a CLI error is reported as **4294967295** (not -1). Results
 *    are therefore detected by the `SyncTeX result begin`/`end` sentinels.
 *
 * A pure-TypeScript reader for `.synctex.gz` is kept as a fallback for machines
 * without `synctex.exe`; it is only consulted when the binary is unavailable or
 * produced no usable record.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import type {
  SynctexForwardRequest,
  SynctexForwardResult,
  SynctexInverseRequest,
  SynctexInverseResult
} from '../../shared/ipc';

/** One `view` record. All geometry is in PDF points (bp), top-left origin. */
export interface SyncTexViewRect {
  page: number;
  x: number;
  y: number;
  /** Enclosing-box left edge. Usually the text margin. */
  h: number;
  /** Box origin baseline; differs from `y` by the box depth. */
  v: number;
  /** Box width. `h + w` is the right edge. */
  w: number;
  /** Box height; legitimately 0 on page-boundary records. */
  hh: number;
  /** Source context, only populated when `-h` was passed. */
  before: string;
  middle: string;
  after: string;
}

/** One `edit` record. */
export interface SyncTexEditRecord {
  output: string;
  input: string;
  line: number;
  column: number;
  offset: number;
}

const SUBPROCESS_TIMEOUT_MS = 20_000;

/**
 * Candidate locations for the SyncTeX command-line client. MiKTeX's own bin
 * directory is the common case on Windows; the bare name is last so a PATH
 * lookup can still succeed on other TeX distributions.
 */
function synctexCandidates(): string[] {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];

  if (process.platform === 'win32') {
    for (const root of [localAppData, programFiles, programFilesX86]) {
      if (!root) continue;
      for (const flavour of ['MiKTeX', 'Programs/MiKTeX']) {
        candidates.push(path.join(root, flavour, 'miktex', 'bin', 'x64', 'synctex.exe'));
        candidates.push(path.join(root, flavour, 'miktex', 'bin', 'synctex.exe'));
      }
    }
  } else {
    candidates.push('/usr/bin/synctex', '/usr/local/bin/synctex', '/Library/TeX/texbin/synctex');
  }

  // A bare name lets the OS resolve it through PATH.
  candidates.push(process.platform === 'win32' ? 'synctex.exe' : 'synctex');
  return candidates;
}

/** Resolve the first existing candidate, or null. */
function findSynctexBinary(configured?: string): string | null {
  if (configured) {
    return fs.existsSync(configured) ? configured : null;
  }
  for (const candidate of synctexCandidates()) {
    if (candidate === 'synctex' || candidate === 'synctex.exe') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

function runSynctex(binary: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    // execFile, never a shell string: a path containing a space must reach the
    // client as a single argv element (it handles those fine), and a relative
    // `-i` never works.
    execFile(
      binary,
      args,
      { cwd, timeout: SUBPROCESS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (error) {
          // A CLI failure shows up as 4294967295 ((uint32)-1), not -1. The exit
          // code is still not authoritative: "No tag", a missing PDF and an
          // out-of-range page all exit 0, so callers gate on the result
          // sentinels rather than on `ok`.
          const raw = (error as unknown as { code?: number | string }).code;
          const code = typeof raw === 'number' ? raw : null;
          resolve({ ok: false, stdout: out, stderr: err, code, error: error.message });
          return;
        }
        resolve({ ok: true, stdout: out, stderr: err, code: 0 });
      }
    );
  });
}

/** Strip the "This is SyncTeX ..." banner and return the result block body. */
function resultBlock(stdout: string): string[] | null {
  const lines = stdout.split(/\r?\n/);
  const begin = lines.findIndex((line) => line.includes('SyncTeX result begin'));
  if (begin < 0) return null;
  const end = lines.findIndex((line, index) => index > begin && line.includes('SyncTeX result end'));
  return lines.slice(begin + 1, end < 0 ? lines.length : end);
}

function parseIntOr(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse `synctex view` output. Multiple records are separated by repeated
 * `Output:` lines, exactly as LaTeX Workshop's `parseToPDFList` does.
 */
export function parseSynctexView(stdout: string): SyncTexViewRect[] {
  const body = resultBlock(stdout);
  if (!body) return [];

  const records: SyncTexViewRect[] = [];
  let current: SyncTexViewRect | null = null;
  let seenPage = false;

  const push = () => {
    if (current && seenPage) records.push(current);
  };

  for (const line of body) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);

    if (key === 'Output') {
      push();
      current = {
        page: 0,
        x: 0,
        y: 0,
        h: 0,
        v: 0,
        w: 0,
        hh: 0,
        before: '',
        middle: '',
        after: ''
      };
      seenPage = false;
      continue;
    }
    if (!current) continue;

    switch (key) {
      case 'Page':
        current.page = parseIntOr(value, 0);
        seenPage = true;
        break;
      case 'x':
        current.x = parseIntOr(value, 0);
        break;
      case 'y':
        current.y = parseIntOr(value, 0);
        break;
      case 'h':
        current.h = parseIntOr(value, 0);
        break;
      case 'v':
        current.v = parseIntOr(value, 0);
        break;
      case 'W':
        current.w = parseIntOr(value, 0);
        break;
      case 'H':
        current.hh = parseIntOr(value, 0);
        break;
      case 'before':
        current.before = value;
        break;
      case 'middle':
        current.middle = value;
        break;
      case 'after':
        current.after = value;
        break;
      default:
        break;
    }
  }
  push();

  return records;
}

/** Parse `synctex edit` output (a single record). */
export function parseSynctexEdit(stdout: string): SyncTexEditRecord | null {
  const body = resultBlock(stdout);
  if (!body) return null;

  const record: SyncTexEditRecord = { output: '', input: '', line: 0, column: -1, offset: -1 };
  let sawLine = false;
  for (const line of body) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    switch (key) {
      case 'Output':
        record.output = value;
        break;
      case 'Input':
        record.input = value.replace(/[\r\n]+/g, '');
        break;
      case 'Line':
        record.line = parseIntOr(value, 0);
        sawLine = true;
        break;
      case 'Column':
        record.column = parseIntOr(value, -1);
        break;
      case 'Offset':
        record.offset = parseIntOr(value, -1);
        break;
      default:
        break;
    }
  }
  if (!sawLine || !record.input) return null;
  return record;
}

/**
 * Chose the rectangle to highlight for a forward search.
 *
 * SyncTeX emits several boxes per hit, and the record count varies with the
 * queried line. The first record is usually the enclosing text block (a `W` as
 * wide as the text column), which reads badly as a highlight; later records are
 * tighter around the actual glyphs. Page-boundary records can legitimately have
 * `H: 0.000000`. So: stay on the earliest page, drop degenerate boxes, and pick
 * the narrowest usable one.
 */
function pickViewRect(records: SyncTexViewRect[]): SyncTexViewRect | null {
  const usable = records.filter((record) => record.page > 0);
  if (usable.length === 0) return null;

  const firstPage = usable[0].page;
  const onFirstPage = usable.filter((record) => record.page === firstPage);

  let best: SyncTexViewRect | null = null;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const record of onFirstPage) {
    if (record.hh <= 0) continue; // page-boundary record: no box
    if (!(record.w > 0)) continue;
    if (record.w < bestWidth) {
      bestWidth = record.w;
      best = record;
    }
  }
  return best ?? onFirstPage.find((record) => record.hh > 0) ?? onFirstPage[0];
}

// ---------------------------------------------------------------------------
// Fallback: pure-TypeScript .synctex.gz reader
// ---------------------------------------------------------------------------

interface SyncPoint {
  fileId: number;
  line: number;
  page: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/**
 * Minimal reader for the SyncTeX file format, used only when `synctex.exe` is
 * unavailable. Ported from the structure light-pdf's `PdfSync.cpp` uses for
 * `.pdfsync`, adapted to SyncTeX's record grammar.
 */
class SyncTexFileIndex {
  private readonly files = new Map<number, string>();
  private readonly points: SyncPoint[] = [];
  private loaded = false;

  load(synctexPath: string): boolean {
    this.files.clear();
    this.points.length = 0;
    this.loaded = false;

    let content: string | null = null;
    try {
      if (!fs.existsSync(synctexPath)) return false;
      if (synctexPath.toLowerCase().endsWith('.gz')) {
        content = zlib.gunzipSync(fs.readFileSync(synctexPath)).toString('utf8');
      } else {
        content = fs.readFileSync(synctexPath, 'utf8');
      }
    } catch {
      return false;
    }
    if (!content) return false;

    let currentPage = 1;
    // TeX coordinates are in scaled points: 1 pt = 65536 sp.
    const SP_PER_POINT = 65536;

    for (const rawLine of content.split(/\r?\n/)) {
      const inputMatch = /^Input:(\d+):(.*)$/.exec(rawLine);
      if (inputMatch) {
        this.files.set(Number(inputMatch[1]), inputMatch[2].trim());
        continue;
      }
      if (rawLine.startsWith('{')) {
        const page = Number(rawLine.slice(1));
        if (Number.isFinite(page) && page > 0) currentPage = page;
        continue;
      }
      const record = /^([xkhvg$r])\s*(\d+),(\d+):(-?\d+),(-?\d+)(?:,(-?\d+),(-?\d+))?/.exec(rawLine);
      if (!record) continue;
      const fileId = Number(record[2]);
      const line = Number(record[3]);
      const x = Number(record[4]) / SP_PER_POINT;
      const y = Number(record[5]) / SP_PER_POINT;
      const w = record[6] !== undefined ? Number(record[6]) / SP_PER_POINT : undefined;
      const h = record[7] !== undefined ? Number(record[7]) / SP_PER_POINT : undefined;
      this.points.push({ fileId, line, page: currentPage, x, y, w, h });
    }

    this.loaded = this.points.length > 0;
    return this.loaded;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Forward lookup from the parser: the closest point at or after `line`. */
  sourceToDoc(srcFileName: string, line: number): SyncTexViewRect | null {
    if (!this.loaded) return null;
    const base = path.basename(srcFileName).toLowerCase();
    let fileId: number | null = null;
    for (const [id, fullPath] of this.files) {
      if (path.basename(fullPath).toLowerCase() === base) {
        fileId = id;
        break;
      }
    }
    if (fileId === null) fileId = 1;

    let best: SyncPoint | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const point of this.points) {
      if (point.fileId !== fileId) continue;
      const delta = Math.abs(point.line - line);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = point;
        if (delta === 0) break;
      }
    }
    if (!best) return null;
    return {
      page: best.page,
      x: best.x,
      y: best.y,
      h: best.h ?? 0,
      v: best.y,
      w: best.w ?? 0,
      hh: best.h ?? 10,
      before: '',
      middle: '',
      after: ''
    };
  }

  /** Inverse lookup from the parser: nearest recorded point on the page. */
  docToSource(page: number, x: number, y: number): SyncTexEditRecord | null {
    if (!this.loaded) return null;
    let best: SyncPoint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const point of this.points) {
      if (point.page !== page) continue;
      const dx = point.x - x;
      const dy = point.y - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
    if (!best) return null;
    return {
      output: '',
      input: this.files.get(best.fileId) ?? '',
      line: best.line,
      column: -1,
      offset: -1
    };
  }

  /** Absolute path of a source file recorded in the index, if present. */
  resolveSourceFile(srcFileName: string): string | null {
    const base = path.basename(srcFileName).toLowerCase();
    for (const fullPath of this.files.values()) {
      if (path.basename(fullPath).toLowerCase() === base) return fullPath;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

interface SyncPaths {
  /** The `.synctex.gz` (or uncompressed `.synctex`) file, when one exists. */
  synctexFile: string | null;
  /** The PDF the sync data belongs to. */
  pdfFile: string;
  /** Directory to spawn the client in, so a relative `-o` resolves. */
  cwd: string;
}

function resolveSyncPaths(inputPath: string): SyncPaths {
  const resolved = path.resolve(inputPath);
  const lower = resolved.toLowerCase();

  if (lower.endsWith('.synctex.gz')) {
    const pdf = resolved.slice(0, -'.synctex.gz'.length) + '.pdf';
    return { synctexFile: resolved, pdfFile: pdf, cwd: path.dirname(resolved) };
  }
  if (lower.endsWith('.synctex')) {
    const pdf = resolved.slice(0, -'.synctex'.length) + '.pdf';
    return { synctexFile: resolved, pdfFile: pdf, cwd: path.dirname(resolved) };
  }
  if (lower.endsWith('.pdf')) {
    const stem = resolved.slice(0, -'.pdf'.length);
    const gz = `${stem}.synctex.gz`;
    const plain = `${stem}.synctex`;
    const synctexFile = fs.existsSync(gz) ? gz : fs.existsSync(plain) ? plain : null;
    return { synctexFile, pdfFile: resolved, cwd: path.dirname(resolved) };
  }

  // Unknown extension: treat it as a PDF stem and look for the sync data.
  const gz = `${resolved}.synctex.gz`;
  const plain = `${resolved}.synctex`;
  return {
    synctexFile: fs.existsSync(gz) ? gz : fs.existsSync(plain) ? plain : null,
    pdfFile: resolved,
    cwd: path.dirname(resolved)
  };
}

/**
 * Resolve the source file path SyncTeX recorded into an absolute path.
 * Recorded paths are usually already absolute on MiKTeX, but a relative one is
 * resolved against the build directory.
 */
function resolveRecordedSource(recorded: string, buildDir: string): string {
  if (!recorded) return '';
  const cleaned = recorded.replace(/[\r\n]+/g, '').trim();
  if (!cleaned) return '';
  if (path.isAbsolute(cleaned)) return path.normalize(cleaned);
  return path.resolve(buildDir, cleaned);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface CachedForward {
  binaryRect: SyncTexViewRect | null;
  raw: string;
}

/**
 * SyncTeX driver. One instance per main process; the binary path is probed once
 * and cached, and parsed `.synctex.gz` indexes are memoised per file with their
 * modification time so a recompile invalidates them.
 */
export class SyncTexEngine {
  private binary: string | null | undefined;
  private binaryConfigured: string | undefined;
  private readonly indexes = new Map<string, { mtimeMs: number; index: SyncTexFileIndex }>();
  private readonly forwardCache = new Map<string, CachedForward>();

  /** Override the SyncTeX client location (used by tests and settings). */
  configure(binaryPath: string | undefined): void {
    this.binaryConfigured = binaryPath;
    this.binary = undefined;
  }

  private getBinary(): string | null {
    if (this.binary === undefined) {
      this.binary = findSynctexBinary(this.binaryConfigured);
    }
    return this.binary;
  }

  /**
   * Whether SyncTeX is usable. True when the command-line client can be found,
   * or when a `.synctex.gz` reader is available (always, since the fallback is
   * pure TypeScript) -- the caller distinguishes by `hasCommandLineClient()`.
   */
  isAvailable(): boolean {
    return true;
  }

  /** True when MiKTeX's `synctex.exe` (or an equivalent) was located. */
  hasCommandLineClient(): boolean {
    return this.getBinary() !== null;
  }

  getBinaryPath(): string | null {
    return this.getBinary();
  }

  /** Forward search: a source position to a PDF page and rectangle. */
  async sourceToDoc(request: SynctexForwardRequest): Promise<SynctexForwardResult | null> {
    const { synctexFile, pdfFile, cwd } = resolveSyncPaths(request.synctexPath);
    const file = resolveRecordedSource(request.file, request.buildDir ?? cwd);
    const line = Math.max(1, Math.floor(request.line));
    // The column field is ignored by the client but must be present, so pass 0.
    const column = 0;

    const binary = this.getBinary();
    if (binary) {
      // `-i` is matched against the path TeX recorded, so it must be absolute.
      const absoluteSource = path.isAbsolute(file) ? file : path.resolve(cwd, file);
      const cacheKey = `${binary}|${pdfFile}|${absoluteSource}|${line}`;
      const cached = this.forwardCache.get(cacheKey);
      if (cached?.binaryRect) {
        return this.toForwardResult(cached.binaryRect, cached.raw);
      }

      // Option order is positional: exactly `view -i <spec> -o <file>` with any
      // of `-d <dir>` after `-o`. `-o` is absolute so the result does not depend
      // on the process cwd. No `-h` and no `-x`: `-h` only works with a hint
      // argument, and `-x` replaces the record block with the external command's
      // output.
      const args = ['view', '-i', `${line}:${column}:${absoluteSource}`, '-o', pdfFile];
      const run = await runSynctex(binary, args, cwd);
      const records = parseSynctexView(run.stdout);
      const picked = pickViewRect(records);
      this.forwardCache.set(cacheKey, { binaryRect: picked, raw: run.stdout });
      if (this.forwardCache.size > 256) {
        this.forwardCache.clear();
      }

      if (picked) {
        return this.toForwardResult(picked, run.stdout);
      }
      // Fall through to the file parser rather than reporting "not found".
    }

    const index = this.loadIndex(synctexFile);
    const fallback = index?.sourceToDoc(file, line) ?? null;
    if (!fallback) return null;
    return {
      page: fallback.page,
      x: fallback.x,
      y: fallback.y,
      width: fallback.w && fallback.w > 0 ? fallback.w : 0,
      height: fallback.hh > 0 ? fallback.hh : 0,
      raw: 'resolved from the .synctex.gz index (no synctex command-line client available)'
    };
  }

  private toForwardResult(rect: SyncTexViewRect, raw: string): SynctexForwardResult {
    return {
      page: rect.page,
      x: rect.x,
      y: rect.y,
      width: rect.w > 0 ? rect.w : 0,
      height: rect.hh > 0 ? rect.hh : 0,
      raw
    };
  }

  /** Inverse search: a PDF position to a source file, line and column. */
  async docToSource(request: SynctexInverseRequest): Promise<SynctexInverseResult | null> {
    const { synctexFile, pdfFile, cwd } = resolveSyncPaths(request.synctexPath);
    const page = Math.max(1, Math.floor(request.page));
    const x = Number.isFinite(request.x) ? request.x : 0;
    const y = Number.isFinite(request.y) ? request.y : 0;

    const binary = this.getBinary();
    if (binary) {
      // `edit -o <page>:<x>:<y>:<file>`; `:` is the only separator the client
      // accepts (a comma is a hard "Bad -o argument").
      const args = ['edit', '-o', `${page}:${x}:${y}:${pdfFile}`];
      const run = await runSynctex(binary, args, cwd);
      const record = parseSynctexEdit(run.stdout);
      if (record && record.input) {
        return {
          file: resolveRecordedSource(record.input, cwd),
          line: Math.max(1, record.line),
          // SyncTeX commonly reports -1, meaning "unknown"; normalise to 0.
          column: record.column >= 0 ? record.column : 0,
          raw: run.stdout
        };
      }
      // Fall through to the file parser.
    }

    const index = this.loadIndex(synctexFile);
    const fallback = index?.docToSource(page, x, y) ?? null;
    if (!fallback || !fallback.input) return null;
    return {
      file: resolveRecordedSource(fallback.input, cwd),
      line: Math.max(1, fallback.line),
      column: 0,
      raw: 'resolved from the .synctex.gz index (no synctex command-line client available)'
    };
  }

  /** Absolute path of a source file named in the sync data, when discoverable. */
  resolveSourceFile(synctexPath: string, fileName: string): string | null {
    const { synctexFile, cwd } = resolveSyncPaths(synctexPath);
    const index = this.loadIndex(synctexFile);
    const recorded = index?.resolveSourceFile(fileName);
    if (!recorded) return null;
    return resolveRecordedSource(recorded, cwd);
  }

  /** Drop memoised indexes (e.g. after a recompile). */
  invalidate(synctexPath?: string): void {
    if (synctexPath) {
      const { synctexFile } = resolveSyncPaths(synctexPath);
      if (synctexFile) this.indexes.delete(path.resolve(synctexFile));
      for (const key of [...this.forwardCache.keys()]) {
        if (key.includes(path.resolve(synctexPath))) this.forwardCache.delete(key);
      }
      return;
    }
    this.indexes.clear();
    this.forwardCache.clear();
  }

  private loadIndex(synctexFile: string | null): SyncTexFileIndex | null {
    if (!synctexFile) return null;
    const key = path.resolve(synctexFile);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(key).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.indexes.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.index.isLoaded()) {
      return cached.index;
    }
    const index = new SyncTexFileIndex();
    if (!index.load(key)) return null;
    this.indexes.set(key, { mtimeMs, index });
    return index;
  }
}

export const syncTexEngine = new SyncTexEngine();
