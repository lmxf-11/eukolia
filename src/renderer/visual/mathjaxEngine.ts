import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const texInput = new TeX({
  packages: AllPackages,
  inlineMath: [['$', '$'], ['\\(', '\\)']],
  displayMath: [['$$', '$$'], ['\\[', '\\]']]
});

const svgOutput = new SVG({ fontCache: 'local' });
const htmlDoc = mathjax.document('', {
  InputJax: texInput,
  OutputJax: svgOutput
});

export class MathJaxEngine {
  private static renderCache = new Map<string, string>();
  private static maxCacheSize = 2000;

  /**
   * Converts TeX/LaTeX math string into SVG markup with LRU caching.
   */
  public static tex2svg(math: string, display: boolean = false, macros?: Record<string, string>): string {
    const trimmed = math.trim();
    if (!trimmed) return '';

    const cacheKey = `${display ? 'D:' : 'I:'}${trimmed}_${macros ? JSON.stringify(macros) : ''}`;
    if (this.renderCache.has(cacheKey)) {
      return this.renderCache.get(cacheKey)!;
    }

    try {
      let fullMath = trimmed;

      // If macros are provided, prepend them as \def declarations
      if (macros && Object.keys(macros).length > 0) {
        const macroDefs = Object.entries(macros)
          .map(([name, def]) => `\\def\\${name}{${def}}`)
          .join(' ');
        fullMath = `${macroDefs} ${fullMath}`;
      }

      const node = htmlDoc.convert(fullMath, {
        display,
        em: 16,
        ex: 8,
        containerWidth: 800
      });

      const inner = adaptor.innerHTML(node);
      let result = inner;

      if (display && !inner.includes('display="true"')) {
        result = `<div class="eukolia-display-math" style="display:flex;justify-content:center;margin:1rem 0;overflow-x:auto;">${inner}</div>`;
      }

      // Store in LRU cache
      if (this.renderCache.size >= this.maxCacheSize) {
        const firstKey = this.renderCache.keys().next().value;
        if (firstKey) this.renderCache.delete(firstKey);
      }
      this.renderCache.set(cacheKey, result);

      return result;
    } catch (err: any) {
      console.warn('MathJax rendering error:', err);
      const fallback = `<span class="math-render-error" style="color:#f87171;font-family:monospace;background:rgba(239,68,68,0.1);padding:2px 4px;border-radius:4px;">${escapeHtml(trimmed)}</span>`;
      return fallback;
    }
  }

  public static clearCache(): void {
    this.renderCache.clear();
    if ('clearCache' in svgOutput && typeof (svgOutput as any).clearCache === 'function') {
      (svgOutput as any).clearCache();
    }
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
