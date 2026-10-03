import { loadMathJax } from '../../src/renderer/math/mathjaxService';
import {
  cachedMathSvg,
  rememberMathSvg,
} from '../../src/renderer/vendor/overleaf/extensions/visual/visual-widgets/math-render-cache';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const loading = loadMathJax();
  check(loading === loadMathJax(), 'Loading should share one promise');
  const api = await loading;
  const render = async (source: string) =>
    (await api.tex2svgPromise(source, {
      display: true,
    })) as unknown as HTMLElement;
  const source = String.raw`\begin{tikzcd} A \arrow[r,"f"] \arrow[d] & B \arrow[d] \\ C \arrow[r] & D \end{tikzcd}`;
  const first = await render(source); // First request is a diagram: exercise the lazy parser retry.
  if (
    new URLSearchParams(location.search).get('scenario') === 'missing-parser'
  ) {
    check(
      first.querySelector('[data-mjx-error]'),
      'Missing parser must report a failure',
    );
    const second = await render(source);
    check(
      second.querySelector('[data-mjx-error]'),
      'A subsequent request must settle too',
    );
  } else {
    check(
      !first.querySelector('[data-mjx-error]'),
      'Diagram must render without a TeX error',
    );
    check(
      first.querySelector('[data-tikzcd-grid="2x2"]'),
      'Missing diagram grid',
    );
    check(
      first.querySelectorAll('[data-tikzcd-shaft]').length === 4,
      'Missing arrows',
    );
    check(
      first.querySelectorAll('[data-tikzcd-head]').length === 4,
      'Missing arrowheads',
    );
    const label = first.querySelector('[data-tikzcd-label]');
    check(
      label?.querySelector('[data-latex="f"] use'),
      'Label must contain typeset glyphs',
    );
    document.body.append(first);
    for (const element of first.querySelectorAll(
      '[data-tikzcd-arrows], [data-tikzcd-shaft], [data-tikzcd-label]',
    )) {
      check(
        element.namespaceURI === 'http://www.w3.org/2000/svg',
        'Arrow element is outside the SVG namespace',
      );
      const box = (element as SVGGraphicsElement).getBBox();
      check(
        box.width > 0 || box.height > 0,
        'Arrow/label has no painted bounds',
      );
    }
    const labelled =
      await render(String.raw`\def\labelmap{\frac{\alpha_1}{\beta^2}}\begin{tikzcd}
      A \arrow[r,"\labelmap"] \arrow[d,"\operatorname{longlabel}"'] & B \arrow[d,"\hat{h}"] \\
      C \arrow[r,"\operatorname{id}"'] & D
      \end{tikzcd}`);
    check(
      !labelled.querySelector('[data-mjx-error]'),
      'Mathematical labels must parse',
    );
    document.body.append(labelled);
    const svg = labelled.querySelector('svg')!;
    const outer = svg.getBoundingClientRect();
    const labels = labelled.querySelectorAll('[data-tikzcd-label]');
    check(labels.length === 4, 'All mathematical labels must be placed');
    check(
      labelled.querySelector('[data-tikzcd-label] [data-mml-node="mfrac"]'),
      'Label macro must expand to a fraction',
    );
    check(
      labelled.querySelector('[data-tikzcd-label] [data-mml-node="mover"]'),
      'Label accent must survive',
    );
    for (const element of labels) {
      check(
        getComputedStyle(element).visibility === 'visible',
        'Placed labels must leave their hidden holders',
      );
      const box = element.getBoundingClientRect();
      check(box.width > 0 && box.height > 0, 'Native label must paint');
      check(
        box.left >= outer.left - 1 &&
          box.right <= outer.right + 1 &&
          box.top >= outer.top - 1 &&
          box.bottom <= outer.bottom + 1,
        `Label exceeds SVG bounds: ${JSON.stringify({ label: box.toJSON(), outer: outer.toJSON() })}`,
      );
    }
    const spaced =
      await render(String.raw`\begin{tikzcd}[row sep=small,column sep=huge]
      A \arrow[r] \arrow[d] & B \arrow[d] \\ C \arrow[r] & D \end{tikzcd}`);
    document.body.append(spaced);
    check(
      !spaced.querySelector('[data-mjx-error]'),
      'Spacing options must render',
    );
    const shafts = [...spaced.querySelectorAll('[data-tikzcd-shaft]')].map(
      (element) =>
        element
          .getAttribute('d')!
          .match(/-?\d+(?:\.\d+)?/g)!
          .map(Number),
    );
    const vertical = shafts.filter(([x1, , x2]) => x1 === x2);
    const horizontal = shafts.filter(([, y1, , y2]) => y1 === y2);
    check(
      vertical.length === 2 && horizontal.length === 2,
      'Spaced square needs four arrows',
    );
    check(
      Math.abs((vertical[1][0] - vertical[0][0]) / 1000 - 6.467) < 0.06,
      'Huge column separation differs from the compiled PDF reference',
    );
    check(
      Math.abs((horizontal[0][1] - horizontal[1][1]) / 1000 - 2.315) < 0.06,
      'Small row separation differs from the compiled PDF reference',
    );
    const unsupported = await render(
      String.raw`\begin{tikzcd}[sep={not-a-length}]A & B\end{tikzcd}`,
    );
    check(
      unsupported
        .querySelector('[data-mjx-error]')
        ?.getAttribute('data-mjx-error')
        ?.includes('Unsupported tikzcd sep'),
      'Unsupported spacing should report its actual cause',
    );
    const styles = await render(String.raw`\begin{tikzcd}
      A \arrow[r,two heads] \arrow[d,Rightarrow] & B \arrow[d,Leftrightarrow] \\
      C \arrow[r,equal] & D \end{tikzcd}`);
    document.body.append(styles);
    check(
      !styles.querySelector('[data-mjx-error]'),
      'Arrow styles must render',
    );
    const arrows = [...styles.querySelectorAll('[data-tikzcd-arrow]')];
    check(arrows.length === 4, 'Style fixture must have four arrows');
    for (const [i, expected] of [
      [0, [1, 0, 2]],
      [1, [2, 0, 1]],
      [2, [2, 1, 1]],
      [3, [2, 0, 0]],
    ] as const) {
      const arrow = arrows[i];
      check(
        arrow.querySelectorAll('[data-tikzcd-shaft]').length === expected[0] &&
          arrow.querySelectorAll('[data-tikzcd-endpoint="start"]').length ===
            expected[1] &&
          arrow.querySelectorAll('[data-tikzcd-endpoint="end"]').length ===
            expected[2],
        `Wrong shafts or tips for style ${i}`,
      );
      for (const path of arrow.querySelectorAll('path')) {
        const box = path.getBBox();
        check(box.width > 0 || box.height > 0, 'Styled arrow path must paint');
      }
    }
    const advancedSources = [
      String.raw`\begin{tikzcd}A \arrow[loop above,"f"] \arrow[loop below,"g"] \arrow[loop left,"\frac{a}{b}"] \arrow[loop right,"h"]\end{tikzcd}`,
      String.raw`\begin{tikzcd}A \arrow[r,Rightarrow,bend left=40,"F"{sloped,pos=.3}] \arrow[r,bend right=35,"G"'] & B\end{tikzcd}`,
      String.raw`\begin{tikzcd}A \arrow[r,hookrightarrow,"i"] & B \arrow[r,mapsto,"\alpha" description] & C\end{tikzcd}`,
      String.raw`\begin{tikzcd}A \arrow[r,"\frac{\alpha}{\beta}"{pos=.2}] \arrow[d,"\operatorname{longlabel}"'] & B \\ C & D\end{tikzcd}`,
    ];
    for (const source of advancedSources) {
      const rendered = await render(source);
      document.body.append(rendered);
      check(
        !rendered.querySelector('[data-mjx-error]'),
        'Advanced diagram must parse',
      );
      const outer = rendered.querySelector('svg')!.getBoundingClientRect();
      for (const element of rendered.querySelectorAll(
        '[data-tikzcd-label], [data-tikzcd-shaft], [data-tikzcd-head]',
      )) {
        const box = element.getBoundingClientRect();
        check(
          box.left >= outer.left - 1 &&
            box.right <= outer.right + 1 &&
            box.top >= outer.top - 1 &&
            box.bottom <= outer.bottom + 1,
          `Advanced diagram is clipped: ${source}: ${JSON.stringify({ box: box.toJSON(), outer: outer.toJSON() })}`,
        );
      }
      for (const use of rendered.querySelectorAll('use')) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href');
        check(
          href && document.getElementById(href.slice(1)),
          'Second layout pass lost a glyph definition',
        );
      }
    }
    const repeatedSource = advancedSources[2];
    const template = await render(repeatedSource);
    const mounted = rememberMathSvg(repeatedSource, true, '', template)!;
    const cached = cachedMathSvg(repeatedSource, true, '')!;
    document.body.append(mounted, cached);
    for (const copy of [mounted, cached]) {
      for (const use of copy.querySelectorAll('use')) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href');
        check(
          href && copy.contains(document.getElementById(href.slice(1))),
          'Cached glyph resolved outside its diagram',
        );
        const box = use.getBBox();
        check(
          box.width > 0 && box.height > 0,
          'Cached glyph lost its geometry',
        );
      }
      for (const path of copy.querySelectorAll('[mask]')) {
        const id = /^url\(#(.+)\)$/.exec(path.getAttribute('mask')!)?.[1];
        check(
          id && copy.contains(document.getElementById(id)),
          'Cached description mask resolved outside its diagram',
        );
      }
    }
    mounted.remove();
    for (const use of cached.querySelectorAll('use')) {
      check(
        use.getBBox().width > 0,
        'Removing a diagram broke another cached copy',
      );
    }
    const malformed = await render(
      String.raw`\begin{tikzcd} \frac{ & \end{tikzcd}`,
    );
    check(
      malformed.querySelector('[data-mjx-error]'),
      'Malformed diagrams must report a recoverable error',
    );
    const empty = await render(String.raw`\begin{tikzcd}\end{tikzcd}+Z`);
    check(
      empty.querySelector('[data-latex="Z"]'),
      'Empty diagram discarded trailing mathematics',
    );
  }
  const ordinary = await render(String.raw`\frac{a}{b}`);
  check(
    !ordinary.querySelector('[data-mjx-error]') &&
      ordinary.querySelector('path'),
    'Ordinary math must still render',
  );
  check(
    [...document.scripts].filter((script) =>
      script.src.endsWith('/tikzcd-parser.mjs'),
    ).length === 1,
    'Parser should be requested once from the extension directory',
  );
}

// Resolve with an error record so failures cross the isolated renderer boundary.
(window as unknown as Record<string, unknown>).mathjaxRendererTest = run().then(
  () => ({ ok: true }),
  (error) => ({ error: String(error.stack || error) }),
);
