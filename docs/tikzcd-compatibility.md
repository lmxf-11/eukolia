# TikZ-CD rendering coverage

The extension runs in Eukolia's vendored MathJax 4 SVG renderer. TeX remains the
document source; diagrams are parsed and drawn locally without invoking a TeX compiler.

## Implemented

- Rectangular grids, nested mathematical environments inside cells, directional arrows,
  multi-cell directions, and numeric `from`/`to` coordinates.
- Native MathJax labels, including document macros, accents, fractions, scripts, and
  operators. Labels share the diagram's font definitions.
- TikZ-CD's default node padding, mathematical axis, stroke width, open CM tips, and
  six named spacing sizes. `sep`, `row sep`, and `column sep` apply in source order.
- Explicit TeX dimensions and macros expanding to dimensions; per-gap `\\[length]`
  and `&[length]`; separation between borders or origins. Physical units scale from
  the 10pt design size with the editor's math font.
  Column gaps are established when their boundary first appears, as in PGF;
  later rows cannot override an existing gap, including a default gap.
- Single and double directional arrows, paired surjection tips, equality strokes,
  hooks, mapsto bars, harpoons, reversed tails, dashed arrows, and head/tail suppression.
  Style names are case-sensitive: `Rightarrow` and `rightarrow` differ.
- `bend left`/`bend right`, explicit `in`/`out` angles, `looseness`, four loop
  directions, and loop `min distance`. Arrow tips follow endpoint tangents.
- `shift left`/`shift right`, with numeric multiples of 0.56ex or explicit lengths.
- Label `pos`, `at start`, `at end`, `near start`, `near end`, `very near start`,
  `very near end`, `swap`, prime placement, named sides, `sloped`,
  `allow upside down`, `xshift`, `yshift`, and `description`.
- Collision clearance from cells and previously placed labels; SVG bounds include
  displaced labels and loops. Description labels cut transparent gaps in arrows,
  including on dark backgrounds.
- Cached widget copies receive unique SVG IDs and rewritten glyph/mask references.
  The cache retains a detached template so edits to a mounted widget cannot alter
  later copies of the diagram.

## Rendering precision and boundaries

Grid and font metrics come from MathJax. Its New Computer Modern font differs slightly
from pdfTeX's Computer Modern. PDF fixtures check appearance and default grid distances;
pixel-for-pixel identity with every TeX engine or font is not expected.

Curved double shafts follow sampled unit-normal offsets of the cubic route. Adaptive
midpoint refinement targets 0.05 SVG units (0.00005em), with a recursion cap for
degenerate curves. This is a numerical approximation, not an exact finite Bézier
representation of an offset curve. Automatic label clearance considers axis-aligned
bounds of cells and labels; it does not reroute the entire diagram to eliminate every
arrow crossing.

This extension does not implement the general PGF key engine. Arbitrary user-defined
TikZ styles, named PGF nodes, decorations, custom arrow declarations, and TeX dimension
register arithmetic are not supported. Unknown diagram/arrow keys may be ignored;
invalid recognized spacing values produce a recoverable TeX error. Use compiled PDF
output to validate diagrams relying on those facilities.

## Verification

- `npx vitest run tests/visual/mathjax.test.ts tests/visual/tikzcd.test.ts tests/visual/realDocumentDefects.test.ts`
- `npm run test:mathjax:renderer` exercises the production service in isolated Electron
  windows under `file://`, including first-load retry and a blocked parser request.
- PDF comparison sources are in `tests/renderer/fixtures/tikzcd-*.tex`.
  `tikzcd-gap-precedence.tex` checks that a first-row 1em addition widens the
  diagram by 10pt at the 10pt design size, while a later-row 4em addition has no
  effect. Compiled widths are 57.64157pt, 67.64157pt, and 57.64157pt; headless
  MathJax column distances are 4.056em, 5.056em, and 4.056em respectively.
- After building, `EUKOLIA_TIKZCD_PROBE=1` with `node scripts/probe-visual.mjs` captures
  a diagram in the actual Visual Editor. `EUKOLIA_PROBE_DOCUMENT` selects a document.

### Current integration verification

The advanced diagram rendered in the isolated production service. Reinspection of
the saved editor screenshot (`.scratch/tikzcd-focused.png`, September 28, 08:10)
also shows the diagram beside its compiled PDF, including the loop, hooks, harpoons,
double curve, and description label. The earlier report that this capture was blank
was incorrect. Its probe reports no MathJax errors or missing glyph references.

The SVG cache now isolates the IDs of repeated diagram copies. DOM checks can verify
reference ownership, but a fresh editor capture of that change remains pending:
the execution sandbox prevents Electron startup (`platform_channel.cc: Access is
denied`) and Vite/Vitest's esbuild child process (`spawn EPERM`). The existing
screenshot predates this cache change and is not verification of the new code.
