/**
 * Maps a hot minified offset back to the source that produced it.
 *
 * `node scripts/locate-in-bundle.mjs <chunk.js> <line> [column]` reads the chunk's
 * source map and prints the original module, line and the source line itself, so a
 * CPU profile that names `index-abc.js:55` becomes a file and a function. Built for
 * one question — "which of these 154 modules is burning ten seconds?" — because a
 * profile of a minified bundle is otherwise a list of positions.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [, , chunkArg, lineArg, columnArg] = process.argv;
if (!chunkArg || !lineArg) {
  console.error('usage: node scripts/locate-in-bundle.mjs <chunk.js> <line> [column] [--context N]');
  process.exit(2);
}

const chunk = path.resolve(chunkArg);
const mapPath = `${chunk}.map`;
if (!existsSync(mapPath)) {
  console.error(`${path.basename(mapPath)} is missing — build with \`npx vite build --sourcemap\`.`);
  process.exit(2);
}

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const targetLine = Number(lineArg);
const targetColumn = columnArg ? Number(columnArg) : 0;
const contextIndex = process.argv.indexOf('--context');
const context = contextIndex !== -1 ? Number(process.argv[contextIndex + 1]) || 0 : 0;

/* ---------------------------------------------------------------- *
 * VLQ decoding, enough of it to read `mappings`
 * ---------------------------------------------------------------- */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHAR_TO_INT = new Map([...BASE64].map((character, index) => [character, index]));

/** One VLQ value from `segments[i]`; returns the value and the next index. */
function decodeVlq(segments, index) {
  let result = 0;
  let shift = 0;
  let continuation = true;
  while (continuation) {
    const digit = CHAR_TO_INT.get(segments[index++]);
    if (digit === undefined) return { value: result, next: index };
    continuation = (digit & 32) !== 0;
    result += (digit & 31) << shift;
    shift += 5;
  }
  const negative = (result & 1) === 1;
  result >>= 1;
  return { value: negative ? -result : result, next: index };
}

// Only the line asked about is decoded: `mappings` is semicolon-separated per
// generated line, so the work is proportional to that line rather than to the file.
const lines = map.mappings.split(';');
if (targetLine - 1 >= lines.length) {
  console.error(`the map has ${lines.length} generated lines; ${targetLine} is past the end`);
  process.exit(1);
}

let sourceIndex = 0;
let sourceLine = 0;
let sourceColumn = 0;
let nameIndex = 0;

for (let generatedLine = 0; generatedLine <= targetLine - 1; generatedLine++) {
  let generatedColumn = 0;
  const segments = lines[generatedLine];
  if (generatedLine < targetLine - 1) {
    // State is cumulative across lines; earlier lines still have to be walked for
    // their deltas even though their positions are not wanted.
    for (const segment of segments.split(',')) {
      if (!segment) continue;
      const parts = segment.split('');
      const fields = [];
      let cursor = 0;
      while (cursor < parts.length) {
        const { value, next } = decodeVlq(parts, cursor);
        fields.push(value);
        cursor = next;
      }
      generatedColumn += fields[0] ?? 0;
      if (fields.length > 3) {
        sourceIndex += fields[1];
        sourceLine += fields[2];
        sourceColumn += fields[3];
      }
      if (fields.length > 4) nameIndex += fields[4];
    }
    continue;
  }

  for (const segment of segments.split(',')) {
    if (!segment) continue;
    const fields = [];
    let cursor = 0;
    while (cursor < segment.length) {
      const { value, next } = decodeVlq(segment, cursor);
      fields.push(value);
      cursor = next;
    }
    const segmentColumn = generatedColumn + (fields[0] ?? 0);
    generatedColumn = segmentColumn;
    if (fields.length <= 3) continue;
    sourceIndex += fields[1];
    sourceLine += fields[2];
    sourceColumn += fields[3];
    if (segmentColumn > targetColumn) break;
  }
}

const source = map.sources[sourceIndex] ?? '(unknown)';
const contents = map.sourcesContent?.[sourceIndex] ?? '';
const sourceLines = contents.split('\n');
const report = {
  generated: `${path.basename(chunk)}:${targetLine}:${targetColumn}`,
  source: source.replace(/^.*?D:\/Projects\/Eukolia\//i, ''),
  sourceLine: sourceLine + 1,
  sourceColumn,
  text: sourceLines[sourceLine] ?? ''
};

console.log(JSON.stringify(report, null, 2));
if (context > 0) {
  const from = Math.max(0, sourceLine - context);
  const to = Math.min(sourceLines.length, sourceLine + context + 1);
  for (let index = from; index < to; index++) {
    console.log(`${index === sourceLine ? '>' : ' '} ${String(index + 1).padStart(5)}  ${sourceLines[index]}`);
  }
}
