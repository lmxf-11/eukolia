/**
 * Eukolia — lightweight settings persistence bridge.
 *
 * Connects `settingsManager` to the main process via IPC for reading and writing
 * user/workspace advanced settings files. Extracted from `services/bootstrap.ts`
 * so standalone windows (Settings and Snippets) can synchronize settings without
 * importing heavy compiler, LSP, or extension host modules.
 */

import { settingsManager } from './settings';

let isBridgeWired = false;

export function wireSettingsBridge(getProjectRoot?: () => string | null): void {
  if (isBridgeWired) return;
  isBridgeWired = true;

  const api = typeof window === 'undefined' ? null : window.eukoliaApi;
  if (!api) return;

  const rootGetter = getProjectRoot ?? (() => null);

  settingsManager.setFileWriter((values) =>
    api.writeAdvancedSettings('user', values, rootGetter())
  );

  const adopt = (scope: 'user' | 'workspace') => {
    void api
      .readAdvancedSettings(scope, rootGetter())
      .then((description) => {
        if (description.error) {
          if (description.error !== 'no project is open') {
            console.warn(`[eukolia] ${scope} advanced settings: ${description.error}`);
          }
          return;
        }
        if (description.values) {
          settingsManager.applyAdvancedSettings(description.values, scope);
        }
        if (scope === 'user' && !description.exists) {
          void api
            .writeAdvancedSettings(
              'user',
              settingsManager.advancedSettingsValues('user'),
              rootGetter()
            )
            .catch((error) => console.warn('[eukolia] could not write user settings file', error));
        }
      })
      .catch((error) => {
        console.warn(`[eukolia] could not read ${scope} advanced settings`, error);
      });
  };

  adopt('user');
  adopt('workspace');

  api.onAdvancedSettingsChanged((description) => {
    if (description.error) {
      console.warn(`[eukolia] ${description.scope} advanced settings: ${description.error}`);
      return;
    }
    settingsManager.applyAdvancedSettings(description.values, description.scope);
  });
}
