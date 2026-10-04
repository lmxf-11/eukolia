/*
 * Does `scrolling.smoothEditor` actually reach the editor?
 *
 * A setting is easy to add and easy to leave unwired — the failure mode this repository has
 * already recorded more than once is a switch that does not change the behaviour and a
 * measurement that then reports the default as if it were the treatment. So this asks the
 * live page three questions and returns the answers rather than a verdict:
 *
 *   1. what `scrolling.smoothEditor` reads as, through the same accessor the handler uses;
 *   2. whether the editor's scroller carries `data-native-scroll`, which is the mark
 *      `smoothScroll.ts` stands down on;
 *   3. whether a wheel notch over the document is intercepted — `defaultPrevented` after
 *      dispatch. **This is the one that matters.** The setting is only real if a notch stops
 *      being cancelled, because a cancelled notch is one the browser was told not to scroll.
 *
 * The runner sets the setting before the page loads
 * (`EUKOLIA_CLIENT_SETTINGS='{"scrolling.smoothEditor":false}'`), so run it twice from one
 * build and compare.
 */
async function settingProbe() {
  const view = window.__cmView;
  if (!view) throw new Error('no window.__cmView');
  const scroller = view.scrollDOM;
  const settle = ms => new Promise(r => setTimeout(r, ms));

  /*
   * The notch is dispatched at a real element inside the document — the scroller's own child —
   * so the handler's search for a scrollable ancestor starts where a pointer would put it.
   */
  const target =
    view.contentDOM.querySelector('.cm-line') ?? view.contentDOM ?? scroller;

  const notch = () => {
    const event = new WheelEvent('wheel', {
      deltaY: 120,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, target: target.className };
  };

  await settle(600);
  const intercepted = notch();
  await settle(400);

  return {
    document: view.state.doc.lines + ' lines',
    /*
     * Read through the same path the handler reads: if this is `false` the setting arrived,
     * and if `nativeScrollMark` is also true then the two agree and the mechanism is wired.
     */
    settingEcho: {
      globalBootstrap: globalThis.__eukoliaSettingsBootstrap ?? null,
      nativeScrollMark: scroller.getAttribute('data-native-scroll'),
      markIsOnScroller: scroller.classList.contains('cm-scroller'),
    },
    wheel: {
      intercepted: intercepted.defaultPrevented,
      dispatchedAt: intercepted.target,
      reading:
        'intercepted false means the notch was left to the browser, which is the whole point of the setting',
    },
    geometry: {
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollTop: Math.round(scroller.scrollTop),
    },
  };
}
return settingProbe();
