/**
 * Builds a LaTeX project of a given size, for the startup profiler.
 *
 * `node scripts/make-large-project.mjs <dir> [chapters]` writes a project with
 * `main.tex`, a macros file the root `\input`s, a bibliography and `chapters`
 * chapter files. It exists so the project-restore measurement is taken against
 * something the size of a real document rather than against the four-file smoke
 * fixture, where every scan finishes before it can be measured.
 *
 * Generated on demand rather than checked in: the point is the *size*, and a
 * hundred thousand lines of generated LaTeX in the repository would be a
 * liability with no reader.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
const chapters = Number(process.argv[3] ?? 120) || 120;

if (!target) {
  console.error('usage: node scripts/make-large-project.mjs <dir> [chapters]');
  process.exit(2);
}

const root = path.resolve(target);
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(path.join(root, 'chapters'), { recursive: true });
mkdirSync(path.join(root, 'figures'), { recursive: true });

const paragraphs = (count, seed) =>
  Array.from({ length: count }, (_, index) => {
    const n = seed + index;
    return [
      `Section ${n} discusses \\R and \\set{} in the context of $\\int_0^\\infty e^{-x^2}\\,dx$.`,
      '',
      `The argument in \\cite{ref${n % 40}} follows \\citet{ref${(n + 7) % 40}}, and the`,
      `bound in Equation~\\eqref{eq:${n}} is tight.`,
      '',
      '\\begin{equation}',
      `  \\label{eq:${n}}`,
      `  \\sum_{k=1}^{${n}} \\frac{1}{k^2} \\le \\frac{\\pi^2}{6}`,
      '\\end{equation}',
      '',
      '\\begin{itemize}',
      `  \\item First point about \\textbf{item ${n}}.`,
      `  \\item Second point about \\emph{item ${n + 1}}.`,
      '\\end{itemize}',
      ''
    ].join('\n');
  }).join('\n');

writeFileSync(
  path.join(root, 'main.tex'),
  [
    '% !TeX program = pdflatex',
    '\\documentclass[11pt,a4paper]{article}',
    '\\usepackage{amsmath,amssymb,graphicx,hyperref}',
    '\\input{macros}',
    '\\begin{document}',
    '\\title{A large generated project}',
    '\\maketitle',
    '\\tableofcontents',
    ...Array.from({ length: chapters }, (_, index) => `\\input{chapters/chapter-${String(index).padStart(3, '0')}}`),
    '\\bibliographystyle{plain}',
    '\\bibliography{refs}',
    '\\end{document}',
    ''
  ].join('\n'),
  'utf8'
);

writeFileSync(
  path.join(root, 'macros.tex'),
  [
    '% Shared macros, reached through \\input — the case that has to be indexed.',
    '\\newcommand{\\R}{\\mathbb{R}}',
    '\\newcommand{\\set}[1]{\\left\\{#1\\right\\}}',
    '\\newcommand{\\norm}[1]{\\left\\lVert #1\\right\\rVert}',
    ''
  ].join('\n'),
  'utf8'
);

for (let index = 0; index < chapters; index++) {
  const name = `chapter-${String(index).padStart(3, '0')}.tex`;
  writeFileSync(
    path.join(root, 'chapters', name),
    [
      `\\section{Chapter ${index}}`,
      `\\label{sec:${index}}`,
      '',
      paragraphs(6, index * 1000)
    ].join('\n'),
    'utf8'
  );
}

writeFileSync(
  path.join(root, 'refs.bib'),
  Array.from(
    { length: 40 },
    (_, index) =>
      `@article{ref${index},\n  title = {Reference ${index}},\n  author = {Author, A. and Other, B.},\n  journal = {Journal of Generated Results},\n  year = {20${String(index).padStart(2, '0')}}\n}\n`
  ).join('\n'),
  'utf8'
);

// A few figures, so the tree has non-source entries too.
for (let index = 0; index < 8; index++) {
  writeFileSync(path.join(root, 'figures', `figure-${index}.tex`), `% figure ${index}\n`, 'utf8');
}

console.log(`wrote ${root}: ${chapters} chapters, macros, bibliography`);
