import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The canonical app/window icon.
 *
 * One file serves every purpose: `electron-builder.json` embeds
 * `assets/icon/icon.ico` into `Eukolia.exe` (`win.icon`) and copies that same file
 * to `<resources>/icon.ico` (`extraResources`), which is what this resolves to in
 * a packaged app. The multi-size frames in it come from
 * `scripts/make-icon.ps1`.
 */
export function resolveAppIconPath(): string {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'icon.ico');
    /*
     * A missing icon is not fatal — Electron falls back to its own — but it is
     * silent, and the cause is always a packaging regression rather than
     * something the user did. Say so once instead of leaving a default icon on
     * screen with no explanation.
     */
    if (!fs.existsSync(packaged)) {
      console.warn(`[eukolia] packaged icon missing at ${packaged}; run \`npm run pack\``);
    }
    return packaged;
  }

  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/icon/icon.ico');
}
