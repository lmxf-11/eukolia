/**
 * Eukolia — boot diagnostics and the loading screen.
 *
 * Two jobs, and both of them have to work before any module has loaded:
 *
 *  - **Diagnostics.** A module that fails to evaluate leaves the window blank
 *    with no explanation. This installs an error handler before the application
 *    module loads so a startup failure is shown in the window and mirrored to the
 *    main-process log.
 *  - **The loading screen.** The window is shown before the entry bundle has been
 *    fetched (see `createWindow` in `src/main/main.ts`), so what the user sees
 *    while the application starts is `#eukolia-boot` in `index.html` — parsed
 *    HTML and CSS, no module, nothing that can fail. This is what reports what is
 *    happening on it and what takes it away again.
 *
 * Kept as an external file (rather than an inline script) so the
 * Content-Security-Policy can forbid inline script entirely.
 */
(function installEukoliaBootDiagnostics() {
  'use strict';

  /*
   * The earliest point on the startup timeline.
   *
   * This file is a classic script in `<head>`, so it runs before the entry
   * module is even fetched — which is the only place the profiler can see how
   * long the browser spent getting from the document to the first line of the
   * application. The two marks are kept on `window` rather than in a module
   * because the module does not exist yet, and the profiler merges them into its
   * own timeline when it reports.
   *
   * Gated on the query parameter the main process adds when
   * `EUKOLIA_STARTUP_PROBE=1`; in a normal launch this is one string search.
   */
  try {
    if (new URLSearchParams(window.location.search).get('eukolia-startup-probe') === '1') {
      var marks = [{ name: 'document:scripts-start', at: Math.round(performance.now() * 10) / 10, delta: 0 }];
      window.__eukoliaStartupMarks = marks;
      window.addEventListener('DOMContentLoaded', function () {
        var at = Math.round(performance.now() * 10) / 10;
        marks.push({ name: 'document:dom-content-loaded', at: at, delta: Math.round((at - marks[marks.length - 1].at) * 10) / 10 });
      });
    }
  } catch (ignored) {
    /* the profiler must never be able to break a launch */
  }

  /* ------------------------------------------------------------------ *
   * The loading screen
   * ------------------------------------------------------------------ */

  var statusNode = document.getElementById('eukolia-boot-status');
  var bootNode = document.getElementById('eukolia-boot');
  var handingOver = false;

  /**
   * Reports what the application is doing while it starts.
   *
   * Called by the renderer as it passes each stage. `textContent` only, so a
   * message from a build's own source cannot become markup, and a missing status
   * node is not an error — the screen is a nicety, not a contract.
   */
  function setStatus(text) {
    if (!statusNode || typeof text !== 'string') return;
    statusNode.textContent = text;
  }

  /**
   * Takes the loading screen away, once, with a fade.
   *
   * The application calls this in the same commit that puts the shell on screen,
   * so the two overlap rather than one following the other — a screen that
   * vanished before the shell existed would leave a blank frame behind it, and one
   * that stayed until the shell had settled would cover the application it was
   * loading.
   *
   * The node is removed rather than hidden. It is a sibling of `#root` and
   * covers the whole window, so a leftover absolute overlay from a plain script
   * is exactly the kind of thing that survives a refactor and then covers a
   * modal.
   *
   * The fade is deliberately short and is *not* awaited by anything: if a browser
   * decides not to run the transition there is still a `setTimeout` behind it, so
   * the screen always goes away.
   */
  function dismiss() {
    if (handingOver) return;
    handingOver = true;
    if (!bootNode) return;
    bootNode.setAttribute('data-dismissed', 'true');
    setTimeout(function () {
      if (bootNode && bootNode.parentNode) bootNode.parentNode.removeChild(bootNode);
    }, 220);
  }

  window.__eukoliaBoot = { setStatus: setStatus, dismiss: dismiss };

  var reported = false;

  function show(message) {
    if (reported) return;
    reported = true;
    // A failure during startup owns the screen: take it out of its hand-over
    // state so an error raised while dismissing is still readable.
    if (bootNode) bootNode.removeAttribute('data-dismissed');

    var panel = document.getElementById('eukolia-boot-error');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'eukolia-boot-error';
      (bootNode || document.body).appendChild(panel);
    }
    panel.style.display = 'block';
    panel.textContent = 'Eukolia failed to start.\n\n' + message;
  }

  function describe(event) {
    var parts = [event.message || String(event.error || 'unknown error')];
    if (event.filename) parts.push('at ' + event.filename + ':' + event.lineno + ':' + event.colno);
    if (event.error && event.error.stack) parts.push(event.error.stack);
    return parts.join('\n');
  }

  window.addEventListener('error', function (event) {
    var message = describe(event);
    show(message);
    try {
      if (window.eukoliaApi && window.eukoliaApi.log) {
        window.eukoliaApi.log('error', 'boot: ' + message);
      } else {
        console.error('[eukolia] boot error', message);
      }
    } catch (ignored) {
      /* logging must never mask the original failure */
    }
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    show(reason && reason.stack ? reason.stack : String(reason));
  });
})();
