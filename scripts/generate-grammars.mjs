/**
 * Eukolia — Lezer grammar build script.
 *
 * Ported from the Overleaf reference:
 *   References/overleaf-main/services/web/scripts/lezer-latex/generate.mjs
 *
 * Compiles the vendored `.grammar` files (copied verbatim from Overleaf) into
 * Lezer parser modules used by Visual Mode and the LaTeX language services.
 *
 * Run with: npm run build:grammars
 */
import { buildParserFile } from '@lezer/generator';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, '../src/renderer/vendor/overleaf');

const grammars = [
  {
    grammarPath: path.join(vendor, 'lezer-latex/latex.grammar'),
    parserOutputPath: path.join(vendor, 'lezer-latex/latex.mjs'),
    termsOutputPath: path.join(vendor, 'lezer-latex/latex.terms.mjs')
  },
  {
    grammarPath: path.join(vendor, 'lezer-bibtex/bibtex.grammar'),
    parserOutputPath: path.join(vendor, 'lezer-bibtex/bibtex.mjs'),
    termsOutputPath: path.join(vendor, 'lezer-bibtex/bibtex.terms.mjs')
  }
];

function compile(grammar) {
  const { grammarPath, termsOutputPath, parserOutputPath } = grammar;
  console.info(`Compiling ${grammarPath}`);

  const grammarText = readFileSync(grammarPath, 'utf8');
  const { parser, terms } = buildParserFile(grammarText, {
    fileName: grammarPath,
    moduleStyle: 'es'
  });

  mkdirSync(path.dirname(parserOutputPath), { recursive: true });
  writeFileSync(parserOutputPath, parser);
  writeFileSync(termsOutputPath, terms);
  console.info(`  -> ${path.relative(process.cwd(), parserOutputPath)}`);
  console.info(`  -> ${path.relative(process.cwd(), termsOutputPath)}`);
}

for (const grammar of grammars) {
  compile(grammar);
}
console.info('Grammar generation complete.');
