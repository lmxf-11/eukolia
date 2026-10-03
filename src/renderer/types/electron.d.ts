/**
 * Eukolia — ambient renderer typings.
 *
 * `window.eukoliaApi` is the only privileged surface the renderer sees. Its type
 * is derived from the preload implementation so the two cannot drift.
 */

import type { EukoliaApi } from '../../preload/preload';

declare global {
  interface Window {
    eukoliaApi: EukoliaApi;
  }
}

export {};
