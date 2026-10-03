/**
 * Status bar formatting.
 *
 * The bar is a dense line of small facts, and almost every defect it can have is
 * a *wording* defect rather than a crash: a build outcome stated twice, `latexmk`
 * named twice, eight tool names where one indicator belongs, a clean build still
 * showing two zeroes, a long path refusing to shrink and pushing the layout
 * cluster off the window. The decisions behind those are pure functions, so they
 * are pinned down here instead of through a rendered component.
 *
 * The last block reads the component's own source, because two of the bar's
 * requirements are global rather than local: it must name only `--eu-*` theme
 * tokens, and it must keep the text the end-to-end harness matches on.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '../../src/shared/ipc';
import type { ThemeSetting } from '../../src/renderer/core/themes';
import {
  OPTIONAL_TOOLS,
  STATUS_MESSAGE_MS,
  buildStatusLabel,
  detectLineEnding,
  formatBuildTooltip,
  formatCursor,
  formatDuration,
  formatEncodingLabel,
  formatIndentation,
  formatLanguageLabel,
  formatProblems,
  formatProblemsTooltip,
  formatThemeLabel,
  formatToolList,
  summariseTools,
  synctexPathFor
} from '../../src/renderer/ui/components/StatusBar';

/** A detected tool, with only the fields the indicator reads. */
const tool = (name: string, available = true): ToolInfo => ({
  name,
  available,
  version: available ? '3.14159265' : null,
  path: available ? `C:\\tex\\bin\\${name}.exe` : null
});

/** The eight tools the application asks the main process to detect. */
const DETECTED = [
  'pdflatex',
  'xelatex',
  'lualatex',
  'latexmk',
  'bibtex',
  'biber',
  'makeindex',
  'synctex'
].map((name) => tool(name));

describe('cursor text', () => {
  it('keeps the wording the end-to-end harness matches on', () => {
    // `smoke.ts` reads the bar with /Ln \d+/, so this string is a contract.
    expect(formatCursor({ line: 251, column: 2, selectedChars: 0 }).position).toBe('Ln 251, Col 2');
  });

  it('says nothing about a selection when there is none', () => {
    expect(formatCursor({ line: 1, column: 1, selectedChars: 0 }).selection).toBeNull();
  });

  it('reports the selection in characters', () => {
    expect(formatCursor({ line: 4, column: 9, selectedChars: 37 }).selection).toBe('37 selected');
  });

  it('separates the two halves so the selection can be drawn quietly', () => {
    const display = formatCursor({ line: 4, column: 9, selectedChars: 37 });
    expect(display.position).not.toContain('selected');
    expect(display.selection).not.toContain('Ln');
  });
});

describe('problem counts', () => {
  it('hides a clean build entirely', () => {
    expect(formatProblems(0, 0)).toEqual({ visible: false, errors: 0, warnings: 0 });
  });

  it('shows the counts as soon as there is something to report', () => {
    expect(formatProblems(1, 2)).toEqual({ visible: true, errors: 1, warnings: 2 });
  });

  it('shows warnings on their own', () => {
    // A document with warnings and no errors is not a clean build.
    expect(formatProblems(0, 3).visible).toBe(true);
  });

  it('shows errors on their own', () => {
    expect(formatProblems(2, 0).visible).toBe(true);
  });

  it('never renders a negative or fractional count', () => {
    expect(formatProblems(-4, 1.6)).toEqual({ visible: true, errors: 0, warnings: 1 });
  });
});

describe('indentation label', () => {
  it('names spaces with the size', () => {
    expect(formatIndentation(2, true)).toEqual({ label: 'Spaces: 2', tabSize: 2, insertSpaces: true });
  });

  it('names tabs as a tab size, as every editor does', () => {
    expect(formatIndentation(4, false).label).toBe('Tab Size: 4');
  });

  it('falls back to a usable size when the setting is nonsense', () => {
    // A zero or negative tab size would otherwise be printed verbatim.
    expect(formatIndentation(0, true).label).toBe('Spaces: 1');
    expect(formatIndentation(Number.NaN, true).label).toBe('Spaces: 1');
  });
});

describe('encoding label', () => {
  it('spells the default encoding as a person writes it', () => {
    expect(formatEncodingLabel('utf8')).toBe('UTF-8');
  });

  it('distinguishes the other two encodings the settings offer', () => {
    expect(formatEncodingLabel('utf16le')).toBe('UTF-16 LE');
    expect(formatEncodingLabel('latin1')).toBe('Latin-1');
  });

  it('accepts the hyphenated spelling too', () => {
    expect(formatEncodingLabel('utf-8')).toBe('UTF-8');
  });

  it('shows an unknown encoding rather than hiding it', () => {
    // Adding an encoding to the settings must not make the item disappear.
    expect(formatEncodingLabel('koi8-r')).toBe('KOI8-R');
  });
});

describe('language mode', () => {
  it('names the modes the editors register', () => {
    expect(formatLanguageLabel('latex')).toBe('LaTeX');
    expect(formatLanguageLabel('bibtex')).toBe('BibTeX');
  });

  it('is absent without a document', () => {
    expect(formatLanguageLabel(null)).toBeNull();
  });

  it('passes an unknown language through rather than inventing a name', () => {
    expect(formatLanguageLabel('markdown')).toBe('markdown');
  });
});

describe('theme label', () => {
  it("shows the theme's own name, not its id", () => {
    expect(formatThemeLabel('catppuccin-latte', 'catppuccin-latte')).toBe('Catppuccin Latte');
    expect(formatThemeLabel('one-dark', 'one-dark')).toBe('One Dark');
  });

  it('names the resolved theme when the setting follows the system', () => {
    expect(formatThemeLabel('system', 'solarized-dark')).toBe('System: Solarized Dark');
  });

  it('covers every theme the picker offers', () => {
    // Eight themes ship; none may render as its raw id or as `undefined`.
    const names = [
      'dark',
      'light',
      'solarized-dark',
      'solarized-light',
      'nord',
      'gruvbox-dark',
      'one-dark',
      'catppuccin-latte'
    ] as ThemeSetting[];
    for (const name of names) {
      const label = formatThemeLabel(name, name);
      expect(label, `${name} has no label`).not.toContain('-');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('tool availability summary', () => {
  it('says nothing has been detected rather than claiming success', () => {
    // An empty list is "detection has not answered", which must not read the
    // same as "answered, and nothing is installed".
    const summary = summariseTools([]);
    expect(summary.detected).toBe(false);
    expect(summary.label).toBe('TeX …');
    expect(summary.tone).toBe('muted');
  });

  it('is a single green tick when everything is present', () => {
    const summary = summariseTools(DETECTED);
    expect(summary).toEqual({ detected: true, label: 'TeX ✓', missing: [], tone: 'success' });
  });

  it('counts only the tools that are actually missing', () => {
    const summary = summariseTools(DETECTED.map((entry) => (entry.name === 'xelatex' ? tool('xelatex', false) : entry)));
    expect(summary.label).toBe('TeX 1 missing');
    expect(summary.missing).toEqual(['xelatex']);
    expect(summary.tone).toBe('warning');
  });

  it('does not count an optional tool as a defect', () => {
    // Documents without an index do not need makeindex, documents without
    // SyncTeX do not need the client, and only the recipes that name them need
    // biber or tectonic: none of them makes a TeX installation incomplete. The
    // list is the build catalogue's own, so a recipe and the indicator cannot
    // disagree about what a machine has to have.
    const withoutOptional = DETECTED.filter(
      (entry) => !OPTIONAL_TOOLS.includes(entry.name) || entry.name === 'synctex'
    ).map((entry) => (OPTIONAL_TOOLS.includes(entry.name) ? tool(entry.name, false) : entry));
    const summary = summariseTools(withoutOptional);
    expect(summary.missing).toEqual([]);
    expect(summary.tone).toBe('success');
    expect(OPTIONAL_TOOLS).toContain('biber');
    expect(OPTIONAL_TOOLS).toContain('tectonic');
  });

  it('is an error when no required compiler was found', () => {
    const summary = summariseTools(DETECTED.map((entry) => tool(entry.name, OPTIONAL_TOOLS.includes(entry.name))));
    expect(summary.tone).toBe('error');
    expect(summary.label).toBe('TeX ✗');
    expect(summary.missing).toContain('pdflatex');
  });

  it('truncates nothing: the names survive in the summary', () => {
    const summary = summariseTools([
      tool('pdflatex', true),
      tool('xelatex', false),
      tool('lualatex', false),
      tool('latexmk', true)
    ]);
    expect(summary.label).toBe('TeX 2 missing');
    expect(summary.missing).toEqual(['xelatex', 'lualatex']);
  });
});

describe('tool tooltip', () => {
  it('gives each tool its status, version and path', () => {
    const text = formatToolList([tool('pdflatex'), tool('biber', false)]);
    expect(text).toContain('pdflatex — found');
    expect(text).toContain('3.14159265');
    expect(text).toContain('C:\\tex\\bin\\pdflatex.exe');
    expect(text).toContain('biber — not found');
    expect(text).toContain('not on PATH');
  });

  it('puts one tool per record, so the tooltip is readable', () => {
    const text = formatToolList(DETECTED);
    // Eight tools, each followed by two detail lines: sixteen blank-line breaks.
    expect(text.split('\n\n').length).toBe(DETECTED.length);
  });

  it('explains an empty list without pretending tools were listed', () => {
    expect(formatToolList([])).toBe('No TeX tools detected yet');
  });
});

describe('build tooltip', () => {
  const recipe = 'latexmk';

  it('names the recipe, the counts and the outcome once each', () => {
    const text = formatBuildTooltip('failed', '1.07 s', {
      recipe,
      currentLabel: 'pdflatex',
      errors: 1,
      warnings: 2
    });
    expect(text).toContain('Build failed in 1.07 s');
    expect(text).toContain('Recipe: latexmk');
    expect(text).toContain('1 error(s), 2 warning(s)');
    // The bar used to say the outcome twice; the tooltip is the one place it is
    // restated, and only on hover.
    expect(text.match(/Build failed/g)).toHaveLength(1);
  });

  it('shows the current step only while a build is running', () => {
    const running = formatBuildTooltip('running', null, {
      recipe,
      currentLabel: 'biber',
      errors: 0,
      warnings: 0
    });
    const finished = formatBuildTooltip('succeeded', '2.00 s', {
      recipe,
      currentLabel: 'biber',
      errors: 0,
      warnings: 0
    });
    expect(running).toContain('Step: biber');
    expect(finished).not.toContain('Step:');
  });

  it('omits the duration when there is not one', () => {
    expect(formatBuildTooltip('idle', null, { recipe, currentLabel: '', errors: 0, warnings: 0 })).toContain(
      'Idle\n'
    );
  });

  it('names what the click does for both a clean and a dirty build', () => {
    expect(formatProblemsTooltip(0, 0, false)).toBe('No problems — show the Problems panel');
    expect(formatProblemsTooltip(1, 2, true)).toBe(
      'Problems: 1 error(s), 2 warning(s) — hide the Problems panel'
    );
  });
});

describe('SyncTeX path', () => {
  it('looks beside the PDF, where every engine writes it', () => {
    expect(synctexPathFor('D:\\paper\\main.pdf')).toBe('D:\\paper\\main.synctex.gz');
  });

  it('is case-insensitive about the extension', () => {
    expect(synctexPathFor('D:/paper/MAIN.PDF')).toBe('D:/paper/MAIN.synctex.gz');
  });

  it('leaves a path that is not a PDF alone', () => {
    expect(synctexPathFor('D:/paper/main.tex')).toBe('D:/paper/main.tex');
  });
});

describe('line-ending detection', () => {
  it('sees Unix endings', () => {
    expect(detectLineEnding('\\documentclass' + '\n' + '\\begin{document}' + '\n')).toBe('LF');
  });

  it('sees Windows endings', () => {
    expect(detectLineEnding('\\documentclass' + '\r\n' + '\\begin{document}' + '\r\n')).toBe('CRLF');
  });

  it('reports a file that mixes the two', () => {
    expect(detectLineEnding('a' + '\r\n' + 'b' + '\n' + 'c' + '\r\n')).toBe('mixed');
  });

  it('has nothing to say about a one-line file', () => {
    expect(detectLineEnding('\\documentclass{article}')).toBeNull();
  });
});

/* ------------------------------------------------------------------ source */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/renderer/ui/components/StatusBar.tsx', import.meta.url)),
  'utf8'
);

/** Every `var(--eu-…)` token the component names. */
const TOKENS = [...SOURCE.matchAll(/var\((--eu-[a-z0-9-]+)\)/g)].map((match) => match[1]);

describe('status bar source', () => {
  it('uses only theme tokens', () => {
    // Every colour in the bar must come from a token; a literal would be wrong
    // in seven of the eight themes.
    expect(TOKENS.length).toBeGreaterThan(0);
    for (const token of TOKENS) {
      expect(token, `${token} is not a theme token`).toMatch(/^--eu-[a-z0-9-]+$/);
    }
  });

  it('hard-codes no colours', () => {
    // The one exception is the popover's drop shadow, which is an alpha black in
    // every theme by design; `box-shadow` is not a themed token.
    const withoutShadow = SOURCE.replace(/boxShadow: '[^']*'/g, '');
    const literals = withoutShadow.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];
    expect(literals).toEqual([]);
  });

  it('keeps the cursor text the end-to-end harness reads', () => {
    // `src/main/smoke.ts` matches the page text against /Ln \d+/.
    expect(SOURCE).toContain('Ln ${cursor.line}, Col ${cursor.column}');
  });

  it('keeps an encoding label the end-to-end harness can find', () => {
    // The harness also matches /utf8/; the label is now spelled UTF-8, which the
    // coordinating agent updates the probe for. It must still be rendered.
    expect(SOURCE).toContain('{encodingLabel}');
    expect(formatEncodingLabel('utf8')).toBe('UTF-8');
  });

  it('is a 22px line, as the window layout expects', () => {
    expect(SOURCE).toMatch(/height: 22\b/);
  });

  it('lets every item shrink so a long name cannot push the layout apart', () => {
    // Without `minWidth: 0` a long path or status message refuses to shrink.
    expect(SOURCE).toContain('minWidth: 0');
    expect(SOURCE).toContain('textOverflow: \'ellipsis\'');
  });

  it('does not render status text in the bar', () => {
    // Per design: text labels (Build failed, Build succeeded, etc.) are removed
    // in favor of the dynamic status icon glyph and tooltip.
    const rendered = SOURCE.match(/<span>\{buildStatusLabel\(build\.status\)\}<\/span>/g) ?? [];
    expect(rendered).toHaveLength(0);
    expect(SOURCE).not.toContain('{statusMessage}');
  });

  it('names the recipe without repeating it in a tool list', () => {
    // The eight-tool list is gone; `latexmk` may only appear as the recipe.
    expect(SOURCE).not.toContain('{tool.name}</span>');
    expect(SOURCE).toContain('{recipe}');
  });

  it('fades a status message instead of leaving it up forever', () => {
    expect(STATUS_MESSAGE_MS).toBeGreaterThan(1000);
    expect(STATUS_MESSAGE_MS).toBeLessThan(30000);
    expect(SOURCE).toContain('useTransientMessage');
  });

  it('dispatches the layout toggles through the command registry', () => {
    // One implementation for the title bar, the palette and the status bar.
    for (const id of ['view.togglePanelBar', 'view.toggleSidebar', 'view.togglePanel', 'pdf.toggleViewer']) {
      expect(SOURCE, `${id} is not dispatched`).toContain(`run('${id}')`);
    }
  });
});

describe('build status label', () => {
  it('names every state the build service has', () => {
    expect(buildStatusLabel('idle')).toBe('Idle');
    expect(buildStatusLabel('running')).toBe('Building…');
    expect(buildStatusLabel('succeeded')).toBe('Build succeeded');
    expect(buildStatusLabel('failed')).toBe('Build failed');
    expect(buildStatusLabel('cancelled')).toBe('Build cancelled');
  });
});

describe('duration format', () => {
  it('uses milliseconds under a second', () => {
    expect(formatDuration(500)).toBe('500 ms');
  });

  it('uses two decimals under ten seconds, one above', () => {
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(15000)).toBe('15.0 s');
  });

  it('has nothing to show for a build that never ran', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});
