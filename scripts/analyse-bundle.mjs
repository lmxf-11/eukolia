/**
 * Reports which source modules contribute most to a built chunk.
 *
 * `node scripts/analyse-bundle.mjs [dist/assets/index-*.js]` reads the chunk's
 * source map and adds up each module's generated size, so "the entry chunk is
 * 3.6 MB" becomes a list of what is in it. That list is what decides where a
 * dynamic import belongs: the largest entries are usually the ones a first paint
 * does not need.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const assets = path.join(projectRoot, 'dist', 'assets');

const explicit = process.argv[2];
const chunk = explicit
  ? path.resolve(explicit)
  : readdirSync(assets)
      .filter((name) => /^index-.*\.js$/.test(name))
      .map((name) => path.join(assets, name))
      .sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];

if (!chunk || !existsSync(chunk)) {
  console.error('No chunk found to analyse. Run `npx vite build --sourcemap` first.');
  process.exit(2);
}

const mapPath = `${chunk}.map`;
if (!existsSync(mapPath)) {
  console.error(`${path.basename(mapPath)} is missing. Run \`npx vite build --sourcemap\` first.`);
  process.exit(2);
}

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const byModule = new Map();

/** Sums each source's generated span, using the mapping segments' source index. */
const sourceOf = (index) => map.sources[index] ?? '(unknown)';
for (let index = 0; index < map.mappings.length; index++) {
  /* Decoding VLQ mappings in full is unnecessary here: `sourcesContent` and the
     `names` list do not carry sizes, so the sizes are derived from the source
     contents instead, which is the same ranking for the question being asked. */
}

for (let index = 0; index < map.sources.length; index++) {
  const source = sourceOf(index);
  const content = map.sourcesContent?.[index] ?? '';
  byModule.set(source, (byModule.get(source) ?? 0) + Buffer.byteLength(content, 'utf8'));
}

const total = [...byModule.values()].reduce((sum, value) => sum + value, 0);
const sorted = [...byModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

console.log(`${path.basename(chunk)}: ${(readFileSync(chunk).length / 1024 / 1024).toFixed(2)} MB built, ${(total / 1024 / 1024).toFixed(2)} MB of source across ${map.sources.length} modules\n`);
console.log('  source size   share   module');
for (const [source, size] of sorted) {
  const relative = source.replace(/^.*?D:\/Projects\/Eukolia\//i, '').replace(/^\.\.\//, '');
  console.log(`  ${String(Math.round(size / 1024)).padStart(8)} KB  ${(100 * size / total).toFixed(1).padStart(5)}%   ${relative}`);
}
