/**
 * Registers (or removes) the `eukolia://` protocol handler for this checkout.
 *
 * On Windows the association is written at runtime: Eukolia calls
 * `setAsDefaultProtocolClient` on every start, so running the app once is enough.
 * electron-builder's `protocols` field cannot be used here — it is macOS-only —
 * and the Windows targets are `dir` and `portable`, which have no installer to
 * write the registry on their behalf.
 *
 * The consequence a user sees is the browser's "A website wants to open this
 * application" prompt, which names the *executable* registered for the scheme.
 * A packaged build registers `Eukolia.exe`, so the prompt says "Eukolia"; a
 * development run can only register `electron.exe`, so it says "Electron". This
 * script makes that explicit instead of surprising:
 *
 *   node scripts/register-protocol.mjs            # show the current handler
 *   node scripts/register-protocol.mjs --register # point eukolia:// at this checkout
 *   node scripts/register-protocol.mjs --unregister
 *
 * Nothing is written unless the target executable is found.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEME = 'eukolia';
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const PACKAGED = path.join(ROOT, 'release', 'win-unpacked', 'Eukolia.exe');
const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEV_ENTRY = path.join(ROOT, 'dist-electron', 'main.js');

const flag = process.argv[2] ?? '';

/** The registry key Windows uses for a URL scheme. */
const CLASSES_KEY = `HKCU\\Software\\Classes\\${SCHEME}`;

function reg(...args) {
  return execFileSync('reg', args, { encoding: 'utf8' });
}

function currentHandler() {
  try {
    const output = reg('query', `${CLASSES_KEY}\\shell\\open\\command`, '/ve');
    const match = /REG_SZ\s+(.+)$/m.exec(output);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function describe(handler) {
  if (!handler) return '(not registered)';
  const exe = /^"([^"]+)"/.exec(handler)?.[1] ?? handler.split(' ')[0];
  const name = path.basename(exe);
  return `${name}  ←  ${handler}`;
}

function register() {
  if (fs.existsSync(PACKAGED)) {
    // The packaged build registers itself on first run; doing it here keeps the
    // name right even before the app has been started.
    execFileSync(PACKAGED, ['--register-protocol'], { stdio: 'inherit' });
    console.log(`Registered ${SCHEME}:// to ${PACKAGED}`);
    return;
  }

  if (!fs.existsSync(DEV_ELECTRON) || !fs.existsSync(DEV_ENTRY)) {
    console.error(
      'Neither a packaged build nor a development build was found.\n' +
        `  packaging:  npm run dist        (expected ${path.relative(ROOT, PACKAGED)})\n` +
        `  developing: npm run build       (expected ${path.relative(ROOT, DEV_ENTRY)})`
    );
    process.exitCode = 1;
    return;
  }

  // The Windows shell stores the command line verbatim; the browser names the
  // executable it finds there, which in development is `electron.exe`.
  const command = `"${DEV_ELECTRON}" "${DEV_ENTRY}" "%1"`;
  reg('add', CLASSES_KEY, '/ve', '/d', `URL:${SCHEME} Protocol`, '/f');
  reg('add', `${CLASSES_KEY}`, '/v', 'URL Protocol', '/d', '', '/f');
  reg('add', `${CLASSES_KEY}\\shell\\open\\command`, '/ve', '/d', command, '/f');

  console.log(`Registered ${SCHEME}:// to ${DEV_ELECTRON} ${DEV_ENTRY}`);
  console.log(
    'Note: the browser will ask to open "Electron", because that is the executable\n' +
      'handling the link in a development run. Run `npm run pack` and launch the\n' +
      'built Eukolia.exe once for the prompt to say "Eukolia" instead.'
  );
}

function unregister() {
  try {
    reg('delete', CLASSES_KEY, '/f');
    console.log(`Removed ${SCHEME}:// from the registry.`);
  } catch {
    console.log(`${SCHEME}:// was not registered.`);
  }
}

switch (flag) {
  case '--register':
    register();
    break;
  case '--unregister':
    unregister();
    break;
  default: {
    const handler = currentHandler();
    console.log(`${SCHEME}:// is handled by: ${describe(handler)}`);
    if (handler && /electron\.exe/i.test(handler)) {
      console.log(
        '\nThis is a development registration, so Windows and browsers name the\n' +
          'handler "Electron". Run `npm run pack` and launch the built Eukolia.exe\n' +
          'once for it to be named "Eukolia".'
      );
    }
  }
}
