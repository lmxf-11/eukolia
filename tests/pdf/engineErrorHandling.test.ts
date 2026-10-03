/**
 * Static check on the native PDF engine's MuPDF error handling.
 *
 * MuPDF's `fz_try` pushes a frame onto the context's error stack that only
 * `fz_catch` (or `fz_always`) pops. Leaving a frame pushed — most easily done by
 * returning out of a `fz_try` block — makes `fz_drop_context` fail its
 * `ctx->error.top == ctx->error.stack_base` assertion, which in the debug MuPDF
 * build aborts the worker process with a modal dialog.
 *
 * This test parses the engine sources and fails on:
 *   1. an unbalanced `fz_try` / `fz_catch` pair;
 *   2. a `return` reached directly inside a `fz_try` body before its `fz_catch`;
 *   3. a `fz_drop_context` (or `fz_drop_*` of the context) inside a `fz_try`.
 *
 * It is a source check rather than a runtime one on purpose: the failure mode is
 * a process abort, which no test can observe from inside the process.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ENGINE_DIR = path.resolve(__dirname, '..', '..', 'src', 'native', 'pdf', 'src');

/** Splits a file into brace-balanced `fz_try` / `fz_always` / `fz_catch` regions. */
interface TryRegion {
  startLine: number;
  body: string;
}

function stripCommentsAndStrings(source: string): string {
  // Remove block comments, line comments and string/char literals so a `return`
  // inside a comment or a message cannot be mistaken for control flow.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/** Finds each `fz_try (...) {` and returns the text up to its matching `}`. */
function findTryBodies(source: string): TryRegion[] {
  const regions: TryRegion[] = [];
  const tryPattern = /\bfz_try\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = tryPattern.exec(source)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    let depth = 0;
    let index = openBrace;
    for (; index < source.length; index++) {
      if (source[index] === '{') depth++;
      else if (source[index] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    regions.push({
      startLine: source.slice(0, match.index).split('\n').length,
      body: source.slice(openBrace, index + 1)
    });
  }
  return regions;
}

const SOURCES = fs
  .readdirSync(ENGINE_DIR)
  .filter((file) => file.endsWith('.cpp'))
  .map((file) => ({ file, source: fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8') }));

describe('native PDF engine MuPDF error handling', () => {
  it('finds the engine sources', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.some((entry) => entry.file === 'mupdf_engine.cpp')).toBe(true);
  });

  it('balances every fz_try with a fz_catch or fz_always', () => {
    for (const { file, source } of SOURCES) {
      const clean = stripCommentsAndStrings(source);
      const tries = (clean.match(/\bfz_try\s*\(/g) ?? []).length;
      const catches = (clean.match(/\bfz_catch\s*\(/g) ?? []).length;
      const always = (clean.match(/\bfz_always\s*\(/g) ?? []).length;

      // `fz_always` is followed by a `fz_catch`, so the catch count covers both.
      expect(catches, `${file}: ${tries} fz_try but ${catches} fz_catch`).toBeGreaterThanOrEqual(tries);
      expect(always, `${file}: more fz_always than fz_try`).toBeLessThanOrEqual(tries);
    }
  });

  it('never returns out of a fz_try body', () => {
    const offenders: string[] = [];

    for (const { file, source } of SOURCES) {
      const clean = stripCommentsAndStrings(source);
      for (const region of findTryBodies(clean)) {
        if (/\breturn\b/.test(region.body)) {
          offenders.push(`${file}:${region.startLine}`);
        }
      }
    }

    expect(
      offenders,
      `these fz_try blocks contain a return, which leaks the error-stack frame ` +
        `and aborts the worker in fz_drop_context: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('never drops the context from inside a fz_try body', () => {
    const offenders: string[] = [];

    for (const { file, source } of SOURCES) {
      const clean = stripCommentsAndStrings(source);
      for (const region of findTryBodies(clean)) {
        if (/\bfz_drop_context\s*\(/.test(region.body)) offenders.push(`${file}:${region.startLine}`);
      }
    }

    expect(offenders, `fz_drop_context inside fz_try: ${offenders.join(', ')}`).toEqual([]);
  });

  it('clears a pending error before dropping the context', () => {
    // The teardown must swallow any queued error, otherwise an earlier uncaught
    // throw trips the same assertion later.
    const engine = SOURCES.find((entry) => entry.file === 'mupdf_engine.cpp');
    expect(engine, 'mupdf_engine.cpp must exist').toBeTruthy();

    const source = engine!.source;
    const dropIndex = source.indexOf('fz_drop_context');
    expect(dropIndex, 'the engine must drop its context').toBeGreaterThan(-1);

    // Walk back from the drop to the start of its enclosing function.
    const before = source.slice(0, dropIndex);
    const functionStart = Math.max(before.lastIndexOf('\n}\n'), 0);
    const teardown = before.slice(functionStart);

    expect(
      /fz_try|fz_catch/.test(teardown),
      'the context teardown must be wrapped in fz_try/fz_catch so a pending error cannot reach fz_drop_context'
    ).toBe(true);
  });
});
