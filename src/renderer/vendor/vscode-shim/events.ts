/**
 * Eukolia — VS Code compatibility layer: disposables and events.
 * Same semantics as the VS Code API so ported extension code is unchanged.
 */

export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn };
}

export class DisposableStore implements Disposable {
  private readonly items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
    } else {
      this.items.push(item);
    }
    return item;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.items.splice(0)) {
      try {
        item.dispose();
      } catch {
        /* disposal must never throw */
      }
    }
  }
}

export type Event<T> = (listener: (e: T) => void, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export type Listener<T> = (e: T) => void;

/**
 * A deferred event emitter. Listeners are invoked synchronously, like VS Code's.
 */
export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = (thisArgs ? listener.bind(thisArgs) : listener) as Listener<T>;
    this.listeners.add(bound);
    const disposable = toDisposable(() => this.listeners.delete(bound));
    if (disposables) disposables.push(disposable);
    return disposable;
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch (err) {
        console.error('[eukolia] event listener threw', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }

  get hasListeners(): boolean {
    return this.listeners.size > 0;
  }
}

/** A promise resolved by calling `resolve`. */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
