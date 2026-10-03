// In-process TypeScript loader for Node 24 regression checks. No compiler subprocess.
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
export function registerTypeScript(overrides = {}) {
  return registerHooks({
    resolve(specifier, context, next) {
      // A bare specifier (`electron`) is overridden by its own name; a relative
      // one is overridden by the absolute URL it resolves to, which is how a
      // specific module inside the source tree is replaced.
      if (overrides[specifier])
        return { url: overrides[specifier], shortCircuit: true };
      if (specifier.startsWith('.')) {
        const url = new URL(specifier, context.parentURL).href;
        if (overrides[url]) return { url: overrides[url], shortCircuit: true };
        for (const extension of ['', '.ts', '.tsx']) {
          const target = url + extension;
          if (target.startsWith('file:') && existsSync(fileURLToPath(target)))
            return { url: target, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.endsWith('.css'))
        return { format: 'module', source: 'export {};', shortCircuit: true };
      if (/\.tsx?$/.test(url) && url.startsWith('file:'))
        return {
          format: 'module',
          shortCircuit: true,
          source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
            fileName: fileURLToPath(url),
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ES2022,
              jsx: ts.JsxEmit.ReactJSX,
            },
          }).outputText,
        };
      return next(url, context);
    },
  });
}
