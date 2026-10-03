/**
 * Eukolia — mathematics rendering service.
 *
 * The loader is a port of Overleaf's `features/mathjax/load-mathjax.ts`
 * (References/overleaf-main/services/web/frontend/js/features/mathjax/load-mathjax.ts),
 * keeping its MathJax configuration verbatim — including the `NoLabelTags`
 * workaround for `align` environments whose labels carry no tag, and the
 * `fontfamily` safe-filter fix.
 *
 * The engine itself is MathJax 4.1.3, the same version as the
 * `References/MathJax-src-master` checkout, loaded from the vendored distribution
 * in `public/mathjax/`. Nothing here talks to a network: Eukolia typesets locally
 * (Instructions.md §10, §26).
 */

export type MathJaxNumbering = 'none-removed' | 'none' | 'ams';

export interface LoadMathJaxOptions {
  enableMenu?: boolean;
  numbering?: MathJaxNumbering;
  singleDollar?: boolean;
  useLabelIds?: boolean;
}

interface MathJaxOutputNode {
  [key: string]: unknown;
}

/** The subset of the MathJax startup API Eukolia uses. */
export interface MathJaxApi {
  startup: {
    promise: Promise<void>;
    document: {
      convert(math: string, options?: Record<string, unknown>): MathJaxOutputNode;
      convertPromise(math: string, options?: Record<string, unknown>): Promise<MathJaxOutputNode>;
      menu?: { menu: { findID(...ids: string[]): { disable(): void } } };
      safe?: {
        filterAttributes: Map<string, string>;
        filterMethods: Record<string, (...args: unknown[]) => unknown>;
      };
    };
    adaptor: {
      outerHTML(node: MathJaxOutputNode): string;
      innerHTML(node: MathJaxOutputNode): string;
      textContent(node: MathJaxOutputNode): string;
    };
  };
  tex2svg(math: string, options?: Record<string, unknown>): MathJaxOutputNode;
  tex2svgPromise(math: string, options?: Record<string, unknown>): Promise<MathJaxOutputNode>;
  tex2mml(math: string, options?: Record<string, unknown>): string;
  tex2mmlPromise(math: string, options?: Record<string, unknown>): Promise<string>;
  texReset(...args: unknown[]): void;
  svgStylesheet(): MathJaxOutputNode;
  getMetricsFor(node: HTMLElement, display: boolean): Record<string, unknown>;
  _: Record<string, unknown>;
}

declare global {
  interface Window {
    MathJax?: MathJaxApi;
  }
}

/** Extra MathJax internals Eukolia reaches into for the tags-factory workaround. */
interface MathJaxInternals {
  _: {
    input: {
      tex: {
        Tags: {
          AbstractTags: new () => {
            currentTag: { tag: string | null };
            label: string;
            autoTag(): void;
            getTag(): unknown;
          };
          TagsFactory: { add(name: string, cls: unknown): void };
        };
      };
    };
  };
  startup: MathJaxApi['startup'] & { defaultReady(): Promise<void> };
}

let mathJaxPromise: Promise<MathJaxApi> | null = null;

const TAGS_NONE_REMOVED: MathJaxNumbering = 'none-removed';

/**
 * Loads MathJax from the vendored distribution. Idempotent: repeated calls share
 * one promise, exactly like the reference implementation.
 */
export function loadMathJax(options: LoadMathJaxOptions = {}): Promise<MathJaxApi> {
  if (mathJaxPromise) return mathJaxPromise;

  mathJaxPromise = new Promise<MathJaxApi>((resolve, reject) => {
    const resolved = {
      enableMenu: false,
      numbering: TAGS_NONE_REMOVED as MathJaxNumbering,
      singleDollar: true,
      useLabelIds: false,
      ...options
    };

    const inlineMath: string[][] = [['\\(', '\\)']];
    if (resolved.singleDollar) {
      inlineMath.push(['$', '$']);
    }

    // https://docs.mathjax.org/en/stable/options/index.html
    const config: Record<string, unknown> = {
      tex: {
        macros: {
          // \bm from the bm package: bold the argument in math mode.
          // https://github.com/mathjax/MathJax/issues/1219#issuecomment-341059843
          bm: ['\\boldsymbol{#1}', 1],

          /*
           * Eukolia: the LaTeX 2.09 font commands, which MathJax 4 no longer has.
           *
           * `\cal`, `\frak`, `\sf`, `\tt`, `\bf`, `\rm`, `\it` and `\Bbb` were
           * removed with the old font-selection machinery, and a document that uses
           * one now gets MathJax's error colour on the command name — `\cal{C}`
           * renders as a red `\cal` followed by a `C`, which is what a real paper
           * looked like. They are not rare: the topology paper this was found on
           * uses `\cal` **38 times**, because `\cal` was standard mathematical
           * notation for a calligraphic family long before `\mathcal` existed, and
           * it is in every `\let\cal\relax`-style preamble written in the 1990s.
           *
           * Defined here rather than left to the `cal` extension that MathJax
           * loads with `\require{cal}`: Visual Mode hands over the mathematics
           * without the document's preamble, so nothing would ask for it.
           */
          cal: '\\mathcal',
          frak: '\\mathfrak',
          Bbb: '\\mathbb',
          sf: '\\mathsf',
          tt: '\\mathtt',
          bf: '\\mathbf',
          rm: '\\mathrm',
          it: '\\mathit',
        },
        inlineMath,
        displayMath: [
          ['\\[', '\\]'],
          ['$$', '$$']
        ],
        packages: {
          '[-]': [
            'html', // avoid creating HTML elements/attributes
            'require', // prevent loading disabled packages
            'textmacros' // text macros are loaded by default in v4, disable them
          ],
          '[+]': ['tikzcd'],
        },
        processEscapes: true,
        processEnvironments: true,
        useLabelIds: resolved.useLabelIds
      },
      output: {
        displayOverflow: 'overflow'
      },
      loader: {
        /*
         * `ui/safe` sanitises URLs embedded in mathematics; it is vendored next to
         * the bundle, so the loader resolves it without network access.
         * `'[tex]/tikzcd'` is Eukolia's port: the environment that draws commutative
         * diagrams, in `public/mathjax/input/tex/extensions/`.
         */
        load: ['ui/safe', '[tex]/tikzcd'],
        dependencies: { '[tex]/tikzcd': ['input/tex'] },
        paths: {
          mathjax: new URL('./mathjax', document.baseURI).href.replace(/\/$/, ''),
          // Fonts are vendored under `public/mathjax/fonts`. Without this,
          // MathJax 4 resolves them to a CDN and mathematics silently fails to
          // render offline (and is blocked by Eukolia's CSP). The path must not
          // look like the CDN, or MathJax appends a version suffix of its own.
          fonts: new URL('./mathjax/fonts', document.baseURI).href.replace(/\/$/, '')
        }
      },
      options: {
        enableMenu: resolved.enableMenu
      },
      startup: {
        typeset: false,
        pageReady() {
          const api = window.MathJax as MathJaxApi;
          api.startup.document.menu?.menu.findID('Settings', 'Renderer')?.disable();
        },
        async ready() {
          const api = window.MathJax as (MathJaxApi & MathJaxInternals) | undefined;
          if (!api) return;

          // A custom tags factory avoids a "multiple label" error in align
          // environments whose labels carry no tag.
          // https://github.com/mathjax/MathJax/issues/3572#issuecomment-4771577206
          if (resolved.numbering === TAGS_NONE_REMOVED) {
            const { AbstractTags, TagsFactory } = api._.input.tex.Tags;
            const Base = AbstractTags;

            class NoLabelTags extends Base {
              autoTag(): void {
                /* intentionally empty: labels are not auto-numbered */
              }
              getTag(): unknown {
                const tag = this.currentTag.tag ? super.getTag() : null;
                this.label = '';
                return tag;
              }
            }

            TagsFactory.add(TAGS_NONE_REMOVED, NoLabelTags);
          }

          await api.startup.defaultReady();

          // Remove anything after a semicolon in the "font-family" attribute so
          // it does not end up in the style attribute.
          // https://github.com/mathjax/MathJax/issues/3129#issuecomment-1807225345
          const safe = api.startup.document.safe;
          if (safe) {
            safe.filterAttributes.set('fontfamily', 'filterFontFamily');
            safe.filterMethods.filterFontFamily = (_safe: unknown, family: unknown) => String(family).split(/;/)[0];
          }
        }
      }
    };

    if (resolved.numbering) {
      (config.tex as Record<string, unknown>).tags = resolved.numbering;
    }

    // With the menu disabled, disable the accessibility features too: they are
    // pure overhead when nothing can open them.
    // https://docs.mathjax.org/en/stable/options/accessibility.html
    if (!resolved.enableMenu) {
      (config.options as Record<string, unknown>).menuOptions = {
        settings: { enrich: false, speech: false, braille: false, assistiveMml: false }
      };
    }

    window.MathJax = config as unknown as MathJaxApi;
    const script = document.createElement('script');
    // Relative so it works both on the Vite dev server and from `file://`.
    script.src = new URL('./mathjax/tex-svg.js', document.baseURI).href;
    script.async = true;
    script.addEventListener('load', () => {
      const api = window.MathJax as MathJaxApi;
      if (!api) {
        reject(new Error('MathJax script loaded but window.MathJax was not defined'));
        return;
      }
      /*
       * `startup.promise` rejects when a package the loader was told to load fails
       * to load, and `window.MathJax` is left half-built: it is on the page, it has
       * its version, and it has none of `tex2svgPromise`, `typesetPromise` or
       * `svgStylesheet`, because those are added by the startup step that never
       * ran. Every mathematics widget then awaits a promise that is never
       * resolved — a blank box with no error anywhere, which is the same shape as
       * a slow render. Reporting the rejection is what turns that into a message.
       */
      // The same seam the probe reads: a startup that neither resolves nor rejects
      // is the failure mode this code exists to make visible, so the state is left
      // where a diagnostic can find it.
      ;(window as unknown as Record<string, unknown>).__eukoliaMathJaxStartup = api.startup.promise
      void api.startup.promise.then(
        () => {
          document.head.appendChild(api.svgStylesheet() as unknown as Node);
          resolve(api);
        },
        (err: unknown) => {
          reject(
            new Error(
              `MathJax startup failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        }
      );
    });
    script.addEventListener('error', () => {
      reject(new Error(`Failed to load MathJax from ${script.src}`));
    });
    document.head.append(script);
  });

  return mathJaxPromise;
}

/** True once MathJax has finished loading. */
export function isMathJaxLoaded(): boolean {
  return window.MathJax !== undefined && mathJaxPromise !== null;
}

export interface TypesetOptions {
  display?: boolean;
  /** Additional macros, `\name` -> replacement (without the backslash). */
  macros?: Record<string, string>;
  /** Font size in pixels used for metrics; defaults to 16. */
  em?: number;
  /** Container width in pixels used for line breaking. */
  containerWidth?: number;
}

export interface TypesetResult {
  /** Serialized SVG markup. */
  svg: string;
  /** Serialized MathML, useful for copy/paste and accessibility. */
  mml?: string;
  width: number;
  height: number;
  /** Error message when MathJax reported a TeX problem. */
  error?: string;
}

/**
 * Local mathematics typesetter with an LRU cache.
 *
 * The cache is keyed on the source plus the display mode and macro set, so
 * re-rendering an unchanged equation is free — which matters because Visual Mode
 * re-typesets on every keystroke (Instructions.md §62).
 */
export class MathJaxService {
  private maxCacheEntries = 3000;
  private readonly cache = new Map<string, TypesetResult>();
  private loaded = false;

  public async ensureLoaded(): Promise<MathJaxApi> {
    const api = await loadMathJax();
    this.loaded = true;
    return api;
  }

  public get isReady(): boolean {
    return this.loaded;
  }

  public setCacheLimit(entries: number): void {
    this.maxCacheEntries = Math.max(64, entries);
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public getCacheSize(): number {
    return this.cache.size;
  }

  private cacheKey(math: string, options: TypesetOptions): string {
    const macros = options.macros && Object.keys(options.macros).length > 0
      ? JSON.stringify(Object.entries(options.macros).sort(([a], [b]) => a.localeCompare(b)))
      : '';
    return `${options.display ? 'D' : 'I'}\u0000${options.em ?? 16}\u0000${options.containerWidth ?? 0}\u0000${macros}\u0000${math}`;
  }

  private remember(key: string, result: TypesetResult): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, result);
  }

  /**
   * Typesets TeX mathematics to SVG.
   *
   * A failure is reported in the returned `error` field rather than thrown, so a
   * malformed equation renders as an error marker without breaking the caller —
   * Visual Mode must always keep the source editable (Instructions.md §24).
   */
  public async typeset(math: string, options: TypesetOptions = {}): Promise<TypesetResult> {
    const trimmed = math.trim();
    if (!trimmed) return { svg: '', width: 0, height: 0 };

    const key = this.cacheKey(trimmed, options);
    const cached = this.cache.get(key);
    if (cached) return cached;

    let api: MathJaxApi;
    try {
      api = await this.ensureLoaded();
    } catch (err) {
      return {
        svg: '',
        width: 0,
        height: 0,
        error: err instanceof Error ? err.message : String(err)
      };
    }

    const macroDefs = buildMacroPreamble(options.macros);
    const source = macroDefs ? `${macroDefs}${trimmed}` : trimmed;

    try {
      const metrics = { em: options.em ?? 16, ex: (options.em ?? 16) / 2, containerWidth: options.containerWidth ?? 100000 };
      const node = await api.tex2svgPromise(source, { display: options.display ?? false, ...metrics });
      const svg = api.startup.adaptor.outerHTML(node);
      const dimensions = measureSvg(svg);

      let mml: string | undefined;
      try {
        mml = await api.tex2mmlPromise(source, { display: options.display ?? false, ...metrics });
      } catch {
        // MathML is a nicety (copy/paste, accessibility); never fail the render for it.
        mml = undefined;
      }

      const failure = detectMathJaxError(svg);
      const result: TypesetResult = {
        svg,
        mml,
        width: dimensions.width,
        height: dimensions.height,
        error: failure
      };
      if (!failure) this.remember(key, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { svg: '', width: 0, height: 0, error: message };
    }
  }

  /** Synchronous variant, for callers already inside a MathJax-ready context. */
  public typesetSync(math: string, options: TypesetOptions = {}): TypesetResult {
    const trimmed = math.trim();
    if (!trimmed) return { svg: '', width: 0, height: 0 };
    const key = this.cacheKey(trimmed, options);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const api = window.MathJax;
    if (!api) return { svg: '', width: 0, height: 0, error: 'MathJax is not loaded yet' };

    try {
      const source = `${buildMacroPreamble(options.macros)}${trimmed}`;
      const metrics = { em: options.em ?? 16, ex: (options.em ?? 16) / 2, containerWidth: options.containerWidth ?? 100000 };
      const node = api.tex2svg(source, { display: options.display ?? false, ...metrics });
      const svg = api.startup.adaptor.outerHTML(node);
      const dimensions = measureSvg(svg);
      const failure = detectMathJaxError(svg);
      const result: TypesetResult = { svg, width: dimensions.width, height: dimensions.height, error: failure };
      if (!failure) this.remember(key, result);
      return result;
    } catch (err) {
      return { svg: '', width: 0, height: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Clears equation numbering/labels — call before typesetting a fresh document. */
  public resetEquationNumbers(): void {
    window.MathJax?.texReset([0]);
  }
}

/**
 * Turns a macro table into `\def` declarations prepended to the source.
 * `\newcommand{\R}{\mathbb{R}}` becomes `\R` -> `\mathbb{R}`.
 */
function buildMacroPreamble(macros: Record<string, string> | undefined): string {
  if (!macros) return '';
  const parts: string[] = [];
  for (const [name, body] of Object.entries(macros)) {
    if (!name || !body) continue;
    const cleanName = name.replace(/^\\/, '');
    if (!/^[A-Za-z@]+$/.test(cleanName)) continue;
    parts.push(`\\def\\${cleanName}{${body}}`);
  }
  return parts.length > 0 ? `${parts.join('')}` : '';
}

function measureSvg(svg: string): { width: number; height: number } {
  const widthMatch = /width="([\d.]+)ex"/.exec(svg);
  const heightMatch = /height="([\d.]+)ex"/.exec(svg);
  const em = 16;
  const ex = em / 2;
  return {
    width: widthMatch ? Number.parseFloat(widthMatch[1]) * ex : 0,
    height: heightMatch ? Number.parseFloat(heightMatch[1]) * ex : 0
  };
}

/** MathJax renders TeX errors as an `merror` element; surface that as an error. */
function detectMathJaxError(svg: string): string | undefined {
  const match = /data-mjx-error="([^"]*)"/.exec(svg);
  if (match) return match[1];
  if (svg.includes('mjx-merror') || svg.includes('<merror')) {
    const message = /title="([^"]*)"/.exec(svg);
    return message ? message[1] : 'TeX error';
  }
  return undefined;
}

export const mathJaxService = new MathJaxService();
