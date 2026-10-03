/**
 * Vitest DOM setup.
 *
 * jsdom implements most of the browser surface but omits a few APIs the app
 * touches during module initialisation (notably `matchMedia`, used by the theme
 * manager to follow the system theme). Stubbing them here keeps DOM-environment
 * tests honest about what the real browser provides.
 */

if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
      })
    });
  }

  if (typeof globalThis.ResizeObserver !== 'function') {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverStub
    });
  }

  if (typeof globalThis.IntersectionObserver !== 'function') {
    class IntersectionObserverStub {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds: readonly number[] = [];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return [];
      }
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: IntersectionObserverStub
    });
  }

  if (typeof globalThis.requestAnimationFrame !== 'function') {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: (handle: number) => clearTimeout(handle)
    });
  }

  /*
   * Some ported modules construct a `Worker` at module scope (Overleaf's LaTeX
   * linter does). In a browser that is correct; under Node the import would
   * reject asynchronously, and an unhandled rejection makes Vitest warn that
   * other failures may be masked. A minimal stand-in keeps the import inert —
   * nothing here pretends to run worker code, so a test that actually needs a
   * worker would still fail.
   */
  if (typeof globalThis.Worker !== 'function') {
    class WorkerStub {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(): void {
        /* no worker code runs under Node */
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      terminate(): void {}
    }
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      writable: true,
      value: WorkerStub
    });
  }

  /*
   * The same module builds its worker's URL as
   * `new Worker(new URL('./x.worker.ts', import.meta.url))`, and Vite resolves
   * that `import.meta.url` through `self.location` — the worker-scope alias.
   * jsdom exposes `window.self` but the module can be evaluated against a global
   * that never received it, which rejects the whole import with
   * "self is not defined" and leaves an unhandled rejection behind. Aliasing it
   * here is the same kind of stand-in as the `Worker` above.
   */
  if (typeof (globalThis as { self?: unknown }).self === 'undefined') {
    Object.defineProperty(globalThis, 'self', {
      configurable: true,
      writable: true,
      value: globalThis
    });
  }
}

export {};
