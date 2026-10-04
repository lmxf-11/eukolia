import React, { useEffect, useState } from 'react';
import { dismissBootScreen } from '../core/bootScreen';
import { settingsManager, setting } from '../core/settings';
import { themeManager, type ThemeSetting } from '../core/themes';
import { wireSettingsBridge } from '../core/settingsBridge';
import { getSnippetStore } from '../snippets/store';
import { SnippetManager } from './components/SnippetManager';

export interface StandaloneSnippetsWindowProps {
  initialSnippetId?: string;
}

export const StandaloneSnippetsWindow: React.FC<StandaloneSnippetsWindowProps> = ({
  initialSnippetId
}) => {
  const [focusSnippetId, setFocusSnippetId] = useState<string | null>(() => {
    if (initialSnippetId) return initialSnippetId;
    if (typeof window !== 'undefined') {
      return new URLSearchParams(window.location.search).get('snippetId');
    }
    return null;
  });

  useEffect(() => {
    dismissBootScreen();
    wireSettingsBridge();

    // Apply the theme the user has saved (or 'system' if none).
    const applyFromSettings = () => {
      const raw = setting.str('general.theme') as ThemeSetting;
      themeManager.apply(raw || 'system');
    };
    applyFromSettings();

    // Re-apply whenever the theme setting changes (e.g. from the main window
    // or the settings bridge picking up a file change).
    const onSettingsChange = (event: Record<string, unknown>) => {
      const key = event.key as string | undefined;
      const advanced = event.advanced as boolean | undefined;
      if (key === 'general.theme' || advanced) applyFromSettings();
    };
    settingsManager.on('change', onSettingsChange);

    const store = getSnippetStore();
    void store.start();

    const unsub = window.eukoliaApi?.onFocusSnippet?.((id) => {
      if (id) setFocusSnippetId(id);
    });

    return () => {
      settingsManager.off('change', onSettingsChange);
      unsub?.();
    };
  }, []);

  return (
    <SnippetManager
      standalone
      open
      focusSnippetId={focusSnippetId}
      /*
       * The two closes are different, and the difference is the library.
       *
       * The manager writes `snippets.json` *as it closes* and stays open with the
       * reason when the write fails, so the window must not be closed from under
       * it: `closeWindow` takes effect the moment it arrives, which would end
       * the renderer in the middle of its own save. It is therefore called by
       * the manager once the write has succeeded, and `discardWindow` is the
       * answer for the close the user insists on after a failed one.
       */
      onClose={() => {
        void window.eukoliaApi?.closeWindow?.();
      }}
      onDiscard={() => {
        void window.eukoliaApi?.discardWindow?.();
      }}
    />
  );
};

export default StandaloneSnippetsWindow;
