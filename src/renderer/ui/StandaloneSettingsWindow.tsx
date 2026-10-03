import React, { useEffect, useState } from 'react';
import { dismissBootScreen } from '../core/bootScreen';
import { settingsManager, setting } from '../core/settings';
import { themeManager, type ThemeSetting } from '../core/themes';
import { wireSettingsBridge } from '../core/settingsBridge';
import { wireKeybindingSettings } from '../services/bootstrap';
import { installCommandCatalog } from '../core/commandCatalog';
import { SettingsView } from './components/SettingsView';
import { StandaloneTitleBar } from './components/StandaloneTitleBar';
import { Settings } from './components/icons';

export interface StandaloneSettingsWindowProps {
  initialSection?: string;
}

export const StandaloneSettingsWindow: React.FC<StandaloneSettingsWindowProps> = ({
  initialSection
}) => {
  const [section, setSection] = useState<string>(() => {
    if (initialSection) return initialSection;
    if (typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('section');
      if (param) return param;
    }
    return 'General';
  });

  useEffect(() => {
    dismissBootScreen();
    wireSettingsBridge();

    /*
     * The keyboard-shortcut editor needs two things this window did not have.
     *
     * **The commands.** They are registered by the app shell in a different
     * renderer, so this window's registry is empty and the editor listed
     * nothing. `installCommandCatalog` fills it from the catalogue the shell
     * publishes, and keeps filling it as the shell republishes.
     *
     * **The bindings.** A shortcut is a *setting* (`keybindings.*`), and the
     * resolver that reads one is installed alongside the registry. Without it
     * the editor showed each command's declared default and a rebind looked like
     * it had reverted the moment the row was redrawn.
     */
    wireKeybindingSettings();
    const offCatalog = installCommandCatalog();

    // Apply the theme the user has saved (or 'system' if none).
    const applyFromSettings = () => {
      const raw = setting.str('general.theme') as ThemeSetting;
      themeManager.apply(raw || 'system');
    };
    applyFromSettings();

    // Re-apply whenever the theme setting changes (e.g. from the settings
    // bridge picking up a file change, or from the user editing the theme
    // in this very window).
    const onSettingsChange = (event: Record<string, unknown>) => {
      const key = event.key as string | undefined;
      const advanced = event.advanced as boolean | undefined;
      if (key === 'general.theme' || advanced) applyFromSettings();
    };
    settingsManager.on('change', onSettingsChange);

    const unsub = window.eukoliaApi?.onNavigateSettings?.((targetSection) => {
      if (targetSection) setSection(targetSection);
    });

    return () => {
      offCatalog();
      settingsManager.off('change', onSettingsChange);
      unsub?.();
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        background: 'var(--eu-bg-app)',
        color: 'var(--eu-fg-primary)',
        overflow: 'hidden'
      }}
    >
      <StandaloneTitleBar
        title="Settings"
        subtitle={section}
        icon={Settings}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative'
        }}
      >
        <SettingsView
          section={section}
          onSectionChange={setSection}
          onOpenSnippets={() => {
            void window.eukoliaApi?.openSnippetsWindow?.();
          }}
        />
      </div>
    </div>
  );
};

export default StandaloneSettingsWindow;
