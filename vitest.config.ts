import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
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
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['References/**', 'node_modules/**', 'dist/**', 'dist-electron/**', 'release/**'],
    environment: 'node',
    setupFiles: ['tests/setup/dom.ts'],
    testTimeout: 30000
  }
});
