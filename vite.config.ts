import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // `node-pty` is a native module: it loads `pty.node` and, on
              // Windows, the ConPTY console host beside it, so it has to be
              // required at runtime rather than inlined into the bundle.
              external: ['electron', 'path', 'fs', 'child_process', 'os', 'crypto', 'events', 'node-pty']
            }
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/renderer/vendor/vscode-shim/index.ts'),
      '@vendor': path.resolve(__dirname, 'src/renderer/vendor'),
      '@': path.resolve(__dirname, 'src/renderer'),
      '@core': path.resolve(__dirname, 'src/renderer/core'),
      '@document': path.resolve(__dirname, 'src/renderer/document'),
      '@parser': path.resolve(__dirname, 'src/renderer/parser'),
      '@editor': path.resolve(__dirname, 'src/renderer/editor'),
      '@visual': path.resolve(__dirname, 'src/renderer/visual'),
      '@snippets': path.resolve(__dirname, 'src/renderer/snippets'),
      '@aligner': path.resolve(__dirname, 'src/renderer/aligner'),
      '@compiler': path.resolve(__dirname, 'src/renderer/compiler'),
      '@pdf': path.resolve(__dirname, 'src/renderer/pdf'),
      '@ui': path.resolve(__dirname, 'src/renderer/ui')
    }
  },
  worker: {
    /*
     * ES modules, not the IIFE default.
     *
     * The one worker left is Overleaf's LaTeX linter (`latex-linter.worker.ts`),
     * and it is constructed as a module worker — `new Worker(new URL(…), { type:
     * 'module' })` — which an IIFE worker would not satisfy.
     *
     * The LaTeX analyzer used to be a second one, and this setting was first
     * written for it: the parser splits its own chunks, and Rollup refuses an IIFE
     * worker with code splitting outright (`Invalid value "iife" for option
     * "worker.format"`, which fails the whole build rather than the worker alone).
     * That worker is gone — the analyzer cannot run in an ES module worker at all,
     * because its dependency chain reaches for CommonJS `require` — and the
     * analyzer now runs in the main process (`src/main/analysis/analyzer.ts`). Do
     * not add it back before that dependency is gone.
     */
    format: 'es'
  },
  server: {
    port: 5173
  }
});
