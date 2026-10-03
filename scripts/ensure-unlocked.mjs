/**
 * Ensures build output directories in `release/win-unpacked` are unlocked
 * by terminating any lingering instances of `Eukolia.exe` on Windows.
 * This prevents `Access is denied` errors when electron-builder attempts
 * to overwrite or delete files like `d3dcompiler_47.dll` or `Eukolia.exe`.
 */
import { execSync } from 'node:child_process';

if (process.platform === 'win32') {
  try {
    execSync('taskkill /F /IM Eukolia.exe /T', { stdio: 'ignore' });
  } catch {
    // Expected when no instances are running.
  }
}
