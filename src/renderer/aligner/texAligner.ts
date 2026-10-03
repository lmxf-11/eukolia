/**
 * Eukolia formatting facade.
 *
 * The implementation lives in `@vendor/tex-aligner` (a port of the reference
 * `tex-aligner` extension). This module adapts it to Eukolia's settings and
 * document model and adds the extensions Instructions.md §14 asks for:
 * alignment on demand, on save, and while typing.
 */

import {
  DEFAULT_TARGET_ENVIRONMENTS,
  TexAligner,
  applyAlignEdits,
  type AlignEdit,
  type AlignOptions
} from '../vendor/tex-aligner/aligner';
import { setting, settingsManager } from '../core/settings';

export { DEFAULT_TARGET_ENVIRONMENTS, TexAligner, applyAlignEdits };
export type { AlignEdit, AlignOptions };

function alignOptionsFromSettings(): AlignOptions {
  const environments = setting.list('formatting.alignEnvironments');
  return {
    environments: environments.length > 0 ? environments : DEFAULT_TARGET_ENVIRONMENTS,
    ampersandPadding: setting.num('formatting.ampersandPadding') || 1
  };
}

/** Builds an aligner from the current Eukolia settings. */
export function createAlignerFromSettings(): TexAligner {
  return new TexAligner(alignOptionsFromSettings());
}

export class FormattingEngine {
  private cachedAligner: TexAligner | null = null;
  private cachedKey = '';

  /** The aligner for the current settings, rebuilt only when the settings change. */
  public get aligner(): TexAligner {
    const key = `${setting.num('formatting.ampersandPadding')}:${setting.list('formatting.alignEnvironments').join(',')}`;
    if (!this.cachedAligner || key !== this.cachedKey) {
      this.cachedAligner = new TexAligner(alignOptionsFromSettings());
      this.cachedKey = key;
    }
    return this.cachedAligner;
  }

  private get enabled(): boolean {
    return setting.bool('formatting.alignAmpersands');
  }

  /**
   * Aligns every targeted environment in `text`.
   * Returns the formatted text (unchanged when nothing needed aligning).
   */
  public alignDocument(text: string): string {
    if (!this.enabled) return text;
    return this.aligner.formatDocument(text);
  }

  /**
   * Returns the minimal set of edits aligning this document.
   * Used by editors that apply changes as deltas rather than whole-buffer writes
   * (Instructions.md §27 — never regenerate unrelated source).
   */
  public alignDeltas(text: string): AlignEdit[] {
    if (!this.enabled) return [];
    return this.aligner.computeEdits(text);
  }

  /** Aligns only the environment enclosing `offset`; returns the deltas. */
  public alignAt(text: string, offset: number): AlignEdit[] {
    if (!this.enabled) return [];
    return this.aligner.computeEdits(text).filter((e) => offset >= e.start && offset <= e.end);
  }

  /** True when the text contains at least one environment this would change. */
  public hasPendingAlignment(text: string): boolean {
    return this.alignDeltas(text).length > 0;
  }
}

export const formattingEngine = new FormattingEngine();

/** Backwards-compatible default instance used by the app shell. */
export const defaultAligner = {
  formatDocument: (text: string) => formattingEngine.aligner.formatDocument(text),
  formatEnvironment: (text: string) => formattingEngine.aligner.formatEnvironment(text),
  computeEdits: (text: string, baseOffset = 0) => formattingEngine.aligner.computeEdits(text, baseOffset)
};

/** Re-exported so callers can react to formatting setting changes. */
export { settingsManager };
