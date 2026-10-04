/*
 * Where does `scrolling.smoothEditor` stop being true-to-life?
 *
 * Four links in the chain, asked separately, because each can fail on its own and the whole
 * point of a switch is that it is connected end to end:
 *
 *   1. the descriptor exists and its default is what was intended;
 *   2. `settingsManager.getValue('scrolling.smoothEditor')` reads that value back — a schema
 *      that rejects the write leaves the setting at its default and looks like a working
 *      switch that changes nothing;
 *   3. the same value through the accessor `smoothScroll.ts` uses;
 *   4. whether the editor's scroller carries the mark the handler stands down on, and —
 *      the one that settles it — whether `onWheel` would bail out for a notch over the
 *      document, which is a question about the `.cm-scroller` ancestor that check tests.
 */
async function settingChainProbe() {
  const view = window.__cmView;
  if (!view) throw new Error('no window.__cmView');
  const scroller = view.scrollDOM;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  await settle(500);

  /*
   * The application's settings module is not on the window, so the two things it can be asked
   * are asked indirectly: the bootstrap global proves what was requested, and the DOM proves
   * what came of it. `data-native-scroll` on the scroller is link 4's observable.
   */
  const line = view.contentDOM.querySelector('.cm-line');
  /*
   * The manager's own answer, which is the link that could not be inferred from the DOM: a
   * write that validation refused, a recompute that overwrote it, or a second copy of the
   * module would all leave the marker reading `true` with no error anywhere.
   */
  const manager = globalThis.__eukoliaSettings;
  const settings = manager
    ? {
        available: true,
        readBack: manager.getValue('scrolling.smoothEditor'),
        descriptor: manager.getDescriptor
          ? (() => {
              const d = manager.getDescriptor('scrolling.smoothEditor');
              return d ? { key: d.key, type: d.type, default: d.default } : null;
            })()
          : 'no getDescriptor',
        scope: manager.getScope ? manager.getScope('scrolling.smoothEditor') : null,
        allScrollingKeys: Object.keys(manager.getAll ? manager.getAll() : {}).filter(k =>
          k.startsWith('scrolling.')
        ),
        allValues: (() => {
          const all = manager.getAll ? manager.getAll() : {};
          const out = {};
          for (const k of Object.keys(all)) if (k.startsWith('scrolling.')) out[k] = all[k];
          return out;
        })(),
      }
    : { available: false };
  return {
    document: view.state.doc.lines + ' lines',
    requested: globalThis.__eukoliaSettingsBootstrap ?? null,
    settings,
    /* Link 4a: what the effect wrote. `data-smooth-editor` proves the effect ran at all. */
    scroller: {
      tag: scroller.className,
      nativeScroll: scroller.getAttribute('data-native-scroll'),
      smoothEditorMarker: scroller.getAttribute('data-smooth-editor'),
      attributes: [...scroller.attributes].map(a => a.name),
    },
    /* Link 4b: what the handler's own ancestor test would find for a notch on a line. */
    ancestorTest: {
      targetClass: line ? line.className : null,
      closestCmScroller: line ? line.closest('.cm-scroller') !== null : null,
      isTheScrollerItself: line ? line.closest('.cm-scroller') === scroller : null,
      closestNativeScroll: line ? line.closest('[data-native-scroll]') !== null : null,
    },
    /* Link 4c: how many other `.cm-scroller` elements are on the page. */
    cmScrollerCount: document.querySelectorAll('.cm-scroller').length,
    /* Anything in the page that would explain a rejected write. */
    capturedErrors: (globalThis.__eukoliaProbeErrors ?? []).slice(-5),
  };
}
return settingChainProbe();
