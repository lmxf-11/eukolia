/**
 * Verifies that the application that was just packaged can actually start.
 *
 * `npm run pack` does not build — it packages whatever is in `dist/` and
 * `dist-electron/` — and `dist/` is generated output that is not committed. So a
 * checkout where the renderer has never been built, or where it was built and
 * then cleaning removed it, packages *successfully* and produces an `app.asar`
 * containing the main process and no renderer at all. The installer is complete,
 * the executable is there, `npm run pack` exits 0, and double-clicking the result
 * does nothing — the main process loads `dist/index.html` out of the archive,
 * fails, and exits with no window and no dialogue.
 *
 * That is the failure this file exists to turn into a message. It checks the two
 * things packaging cannot check for itself:
 *
 *  1. **The build output is a build.** `dist/index.html` exists and every asset it
 *     references exists beside it, and `dist-electron/` holds the main process and
 *     the preload. A `dist/` that was deleted, or one whose hashed chunks were
 *     replaced by a build that did not finish, fails here.
 *  2. **The package contains it.** With `--package <dir>`, the `app.asar` in a
 *     packaged output is read back and the same files are required inside it, so
 *     "the archive was written empty" is caught as well.
 *
 * It is a guard, not a build: it never writes anything and never fixes anything.
 * If it fails, the answer is `npm run build` (or `npm run dist`, which builds
 * first), and the message says so.
 *
 * Usage:
 *   node scripts/verify-package.mjs
 *   node scripts/verify-package.mjs --package release/win-unpacked
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const packageIndex = process.argv.indexOf('--package');
const packageDir = packageIndex !== -1 && process.argv[packageIndex + 1] ? path.resolve(process.argv[packageIndex + 1]) : null;

const problems = [];

/** Records a missing file with the reason it matters. */
function require_(filePath, why) {
  if (existsSync(filePath)) return true;
  problems.push(`missing ${path.relative(projectRoot, filePath) || filePath} — ${why}`);
  return false;
}

/**
 * Every script and stylesheet `index.html` loads, as absolute paths.
 *
 * Read out of the built document rather than listed here, because the asset names
 * are content-hashed: a hard-coded list would go stale on the first build and
 * would then pass while the real entry point was missing. `src`/`href` values
 * that are already absolute URLs (a dev server, an inline `data:` font) are
 * skipped — only the document's own files are checked.
 *
 * `esModule` is carried because it is what distinguishes the two kinds of script
 * in this document: the entry bundle (`type="module"`, emitted by Vite, hundreds
 * of kilobytes) and the boot helpers (`public/eukolia-boot.js`,
 * `public/eukolia-require-shim.js` — a few kilobytes each, and correct at that
 * size). Only the first kind can be a stub.
 */
function referencedAssets(indexHtmlPath) {
  const html = readFileSync(indexHtmlPath, 'utf8');
  const directory = path.dirname(indexHtmlPath);
  const found = [];
  for (const match of html.matchAll(/<script([^>]*)\ssrc="([^"]+)"([^>]*)>/g)) {
    found.push({ reference: match[2], esModule: /type\s*=\s*"module"/i.test(`${match[1]} ${match[3]}`) });
  }
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    found.push({ reference: match[1], esModule: false });
  }
  return found
    .filter((entry) => !/^(?:[a-z]+:)?\/\//i.test(entry.reference) && !entry.reference.startsWith('data:'))
    .map((entry) => ({
      ...entry,
      resolved: path.resolve(directory, entry.reference.replace(/^\//, ''))
    }));
}

/* ------------------------------------------------------------------ *
 * 1. The build output on disk
 * ------------------------------------------------------------------ */

const distIndex = path.join(projectRoot, 'dist', 'index.html');
const mainBundle = path.join(projectRoot, 'dist-electron', 'main.js');

if (require_(distIndex, 'the renderer has not been built; run `npm run build`')) {
  const assets = referencedAssets(distIndex);
  if (assets.length === 0) {
    problems.push('dist/index.html references no scripts — it is not a Vite build output; run `npm run build`');
  }
  for (const asset of assets) {
    require_(asset.resolved, `dist/index.html loads it (${asset.reference})`);
  }
  /*
   * The entry bundle is the one asset whose absence is invisible until the window
   * opens: `index.html` is a valid document without it, so a half-finished build
   * leaves a page that paints the loading screen and stops. A size check is crude
   * and is meant to be: the module bundle is hundreds of kilobytes, so one of a
   * few kilobytes is a stub rather than a build.
   */
  for (const asset of assets) {
    if (!asset.esModule || !asset.reference.endsWith('.js') || !existsSync(asset.resolved)) continue;
    const bytes = statSync(asset.resolved).size;
    if (bytes < 50_000) {
      problems.push(
        `dist/${path.basename(asset.resolved)} is ${bytes} bytes — the entry bundle is a stub, not a build; run \`npm run build\``
      );
    }
  }
}

require_(mainBundle, 'the main process has not been built; run `npm run build`');
require_(
  path.join(projectRoot, 'dist-electron', 'preload.cjs'),
  'the preload bridge has not been built; run `npm run build:preload`'
);

/* ------------------------------------------------------------------ *
 * 2. What the package actually contains
 * ------------------------------------------------------------------ */

if (packageDir) {
  const asarPath = path.join(packageDir, 'resources', 'app.asar');
  require_(path.join(packageDir, 'Eukolia.exe'), 'the packaged Windows executable is missing');
  require_(path.join(packageDir, 'resources', 'icon.ico'), 'the app/window icon was not packaged');
  require_(path.join(packageDir, 'resources', 'native', 'eukolia-pdf.exe'), 'the native PDF worker was not packaged');
  require_(path.join(packageDir, 'resources', 'native', 'libmupdf.dll'), 'the PDF runtime was not packaged');
  if (!existsSync(packageDir)) {
    problems.push(`missing ${path.relative(projectRoot, packageDir)} — the requested package was not produced`);
  } else if (!existsSync(asarPath)) {
    problems.push(
      `${path.relative(projectRoot, asarPath)} was not written — the package has no application in it; re-run \`npm run pack\``
    );
  } else {
    let listPackage = null;
    try {
      ({ listPackage } = await import('@electron/asar'));
    } catch {
      problems.push('@electron/asar is unavailable — the requested archive could not be verified');
    }
    if (listPackage) {
      /** Asar stores forward-slash paths with no leading separator. */
      const inside = new Set(
        listPackage(asarPath).map((entry) => String(entry).replace(/^[/\\]+/, '').replace(/\\/g, '/'))
      );
      const required = ['dist-electron/main.js', 'dist-electron/preload.cjs', 'dist/index.html', 'package.json'];
      for (const name of required) {
        if (!inside.has(name)) {
          problems.push(`the packaged ${path.basename(asarPath)} does not contain ${name} — the app would start and exit`);
        }
      }
      // Every asset the document loads has to be inside too, or the window opens
      // on the loading screen and stays there.
      if (existsSync(distIndex)) {
        for (const asset of referencedAssets(distIndex)) {
          const name = path.relative(path.join(projectRoot, 'dist'), asset.resolved).replace(/\\/g, '/');
          if (!inside.has(`dist/${name}`)) {
            problems.push(`the packaged ${path.basename(asarPath)} does not contain dist/${name} — the window would open empty`);
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

if (problems.length > 0) {
  console.error('The packaged application would not start:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\n`npm run build && npm run pack` produces a package that runs; `pack` alone does not build.');
  process.exit(1);
}

const inspected = Boolean(packageDir && existsSync(packageDir) && existsSync(path.join(packageDir, 'resources', 'app.asar')));
console.log(
  inspected
    ? `package verified: dist/ and dist-electron/ are a complete build, and ${path.relative(projectRoot, packageDir)} contains them`
    : 'build output verified: dist/ and dist-electron/ are complete (no packaged archive was inspected)'
);
