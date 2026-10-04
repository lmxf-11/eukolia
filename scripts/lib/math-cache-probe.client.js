/*
 * What each MathJax `fontCache` mode actually puts into the *document*, through the
 * application's own serialisation path.
 *
 * The unit test (`tests/visual/mathFontCache.test.ts`) measures MathJax's Node entry point
 * and prints `document: path 0 pathData 0` for both modes, which says only that the
 * LiteDOM adaptor's document carries no glyph data — it cannot say where `global` put it,
 * because the editor does not use that entry point. The editor uses the browser build
 * (`public/mathjax/tex-svg.js`) and serialises **one node** with
 * `adaptor.outerHTML(node)` (`mathjaxService.ts`), then hands that string to a widget
 * which sets it as `innerHTML`. So the question this answers is the only one that matters:
 * after that round trip, does an equation have the glyph outlines it references?
 *
 * Three modes, each rendered twice (once to populate whatever cache it uses, once to read
 * the result a *second* equation would get):
 *
 *   local  — the shipped default; `<defs>` inside the equation's own `<svg>`
 *   global — definitions extracted to one container in the document
 *   none   — every `<use>` replaced by an inline `<path>`, no references at all
 *
 * The report is per mode: what the app would embed (the serialised string), what is in
 * the live DOM, and whether each `<use href="#id">` in the embedding resolves to an
 * element that exists in the document. `danglingRefs > 0` is a broken equation.
 */
async function mathCacheProbe() {
  const MathJax = window.__eukoliaMathJax;
  if (!MathJax || typeof MathJax.tex2svgPromise !== 'function') {
    throw new Error('no MathJax on window.__eukoliaMathJax');
  }
  const adaptor = MathJax.startup.adaptor;
  const svgJax = MathJax.startup.document.outputJax;
  const original = svgJax.options.fontCache;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;';
  document.body.appendChild(host);

  const count = (markup, pattern) => (markup.match(pattern) ?? []).length;
  const describe = (markup, label) => ({
    label,
    bytes: markup.length,
    elements: count(markup, /<[a-zA-Z]/g),
    path: count(markup, /<path/g),
    use: count(markup, /<use/g),
    defs: count(markup, /<defs/g),
    g: count(markup, /<g[ >]/g),
    pathData: [...markup.matchAll(/ d="([^"]*)"/g)].reduce((n, m) => n + m[1].length, 0),
    refs: [...markup.matchAll(/href="#([^"]+)"/g)].map(m => m[1]),
  });

  const TEX = ['a_1^2 + b', '\\frac{n(n+1)}{2}', '\\alpha\\beta\\gamma\\delta'];
  const report = { modes: {}, order: ['local', 'global', 'none'] };

  for (const mode of report.order) {
    const entry = { mode, embeds: [], live: null, dangling: [], note: null };
    try {
      svgJax.options.fontCache = mode;
      for (let i = 0; i < TEX.length; i += 1) {
        const node = await MathJax.tex2svgPromise(TEX[i], { display: false, em: 16, ex: 8 });
        const markup = adaptor.outerHTML(node);
        entry.embeds.push(describe(markup, TEX[i]));
        // Exactly what the widget does: embed the string, in the live document.
        const mount = document.createElement('span');
        mount.innerHTML = markup;
        host.appendChild(mount);
      }
      /*
       * The serialised markup is stamped into the DOM before anything is measured, so a
       * `<use>` that resolves has resolved *against the live document* — which is where
       * the real editor puts it.
       */
      const first = host.querySelector('svg');
      entry.firstSvgWidth = first ? first.getAttribute('width') : null;
      entry.live = {
        svgInDocument: host.querySelectorAll('svg').length,
        uses: host.querySelectorAll('use').length,
        pathsInDocument: host.querySelectorAll('path').length,
        globalCacheContainers: host.querySelectorAll('[id*="cache"], [id*="Cache"]').length,
        documentCacheContainers: document.querySelectorAll(
          '[id*="MJX-SVG-global-cache"], [id*="mjx-svg-global-cache"]'
        ).length,
      };
      for (const embed of entry.embeds) {
        for (const ref of embed.refs) {
          if (!document.getElementById(ref)) entry.dangling.push(ref);
        }
      }
      entry.note =
        entry.dangling.length > 0
          ? 'REFERENCES AN ELEMENT THAT DOES NOT EXIST — the equation embeds as empty boxes'
          : 'every reference resolves';
    } catch (error) {
      entry.note = 'FAILED ' + String(error && error.message ? error.message : error);
    }
    report.modes[mode] = entry;
    host.replaceChildren();
  }
  svgJax.options.fontCache = original;
  report.restoredFontCache = original;
  host.remove();
  return report;
}
return mathCacheProbe();
