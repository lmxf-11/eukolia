/*
 * Is the bootstrap write reaching the settings the editor reads?
 *
 * The marker attribute (`data-smooth-editor`, written by the editor's own effect) reads `true`
 * while the write asked for `false`, so something between them disagrees. This asks each
 * participant separately, in the page, rather than inferring:
 *
 *   requested      what the runner queued
 *   managerGlobal  what the page put on `globalThis.__eukoliaSettings` when it applied it
 *   readBack       that manager's own answer for the key
 *   descriptor     whether the schema knows the key at all — a key the schema does not
 *                  declare still stores, but a *typo'd* key would not be found here
 *   marker         what the editor's effect wrote, which is the value it actually read
 */
async function bootstrapProbe() {
  const view = window.__cmView;
  if (!view) throw new Error('no window.__cmView');
  await new Promise(r => setTimeout(r, 500));

  const manager = globalThis.__eukoliaSettings;
  /*
   * The write happens **here**, not before the page loads: an injected script runs after the
   * application has started, so a global set by the runner is set too late for `main.tsx` to
   * read it. `setValue` is the same call the Settings window makes, so every subscriber is
   * told and the editor's own effect reacts to it.
   */
  const requested = globalThis.__eukoliaSettingsBootstrap ?? null;
  const applied = [];
  if (manager && requested) {
    for (const [key, value] of Object.entries(requested)) {
      try {
        manager.setValue(key, value);
        applied.push({ key, value, readBack: manager.getValue(key) });
      } catch (error) {
        applied.push({ key, value, error: String(error).slice(0, 200) });
      }
    }
    /* Let the change propagate through the subscribers before anything is read. */
    await new Promise(r => setTimeout(r, 600));
  }

  const descriptor = manager && manager.getDescriptor
    ? manager.getDescriptor('scrolling.smoothEditor')
    : undefined;
  const all = manager && manager.getAll ? manager.getAll() : null;

  /*
   * A notch, dispatched at a real line, to see whether the handler still calls
   * `preventDefault`. `intercepted: false` is the only proof the setting is connected: a
   * cancelled notch is one the browser was told not to scroll.
   */
  const line = view.contentDOM.querySelector('.cm-line');
  const event = new WheelEvent('wheel', {
    deltaY: 120,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
  });
  ;(line ?? view.contentDOM).dispatchEvent(event);
  await new Promise(r => setTimeout(r, 300));

  return {
    document: view.state.doc.lines + ' lines',
    requested,
    applied,
    managerGlobal: {
      present: Boolean(manager),
      hasSetValue: Boolean(manager && manager.setValue),
    },
    readBack: manager && manager.getValue ? manager.getValue('scrolling.smoothEditor') : 'no manager',
    descriptor: descriptor
      ? { key: descriptor.key, type: descriptor.type, default: descriptor.default }
      : null,
    /* Every `scrolling.*` key the manager holds — the write should appear here. */
    storedScrollingKeys: all
      ? Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('scrolling.')))
      : null,
    wheel: {
      intercepted: event.defaultPrevented,
      reading: 'intercepted false means the notch was left to the browser',
    },
    marker: {
      dataSmoothEditor: view.scrollDOM.getAttribute('data-smooth-editor'),
      dataNativeScroll: view.scrollDOM.getAttribute('data-native-scroll'),
    },
  };
}
return bootstrapProbe();

