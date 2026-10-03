/**
 * Summarises a V8 `.cpuprofile` by self time, per function.
 *
 * A one-off investigation tool, not part of the build: `node
 * scripts/analyse-cpuprofile.mjs <file> [--range from,to]` prints the functions
 * the renderer actually spent its time in, and `--range` restricts the answer to
 * a window of the timeline (milliseconds after navigation start) so a specific
 * gap can be attributed rather than the whole launch.
 */
import { readFileSync } from 'node:fs';

const [, , file, ...rest] = process.argv;
if (!file) {
  console.error('usage: node scripts/analyse-cpuprofile.mjs <file.cpuprofile> [--range from,to] [--top 25]');
  process.exit(2);
}

const rangeIndex = rest.indexOf('--range');
const range = rangeIndex !== -1 && rest[rangeIndex + 1] ? rest[rangeIndex + 1].split(',').map(Number) : null;
const topIndex = rest.indexOf('--top');
const top = topIndex !== -1 ? Number(rest[topIndex + 1]) || 25 : 25;

const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));

/** V8 reports microseconds; the profile's start is in microseconds since epoch. */
const startUs = profile.startTime;
const toMs = (stamp) => (stamp - startUs) / 1000;

const selfTime = new Map();
let totalSamples = 0;

for (let index = 0; index < profile.samples.length; index++) {
  const id = profile.samples[index];
  const at = toMs(profile.timeDeltas ? startUs + cumulativeDelta(index) : startUs);
  if (range && (at < range[0] || at > range[1])) continue;
  const node = byId.get(id);
  if (!node) continue;
  const frame = node.callFrame;
  const key = `${frame.functionName || '(anonymous)'}  ${String(frame.url).replace(/^.*[\\/]/, '')}:${frame.lineNumber + 1}`;
  selfTime.set(key, (selfTime.get(key) ?? 0) + 1);
  totalSamples++;
}

function cumulativeDelta(index) {
  let sum = 0;
  for (let i = 0; i <= index; i++) sum += profile.timeDeltas[i] ?? 0;
  return sum;
}

const sorted = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
console.log(`${totalSamples} samples${range ? ` in ${range[0]}–${range[1]} ms` : ''} (≈${totalSamples} ms of CPU)`);
for (const [key, count] of sorted) {
  console.log(`  ${String(count).padStart(6)} ms  ${key}`);
}
