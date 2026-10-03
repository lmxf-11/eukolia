/**
 * Eukolia substitution for Overleaf's `infrastructure/local-storage`.
 *
 * Overleaf keeps editor positions in `localStorage` with a JSON envelope.
 * Eukolia keeps the same behaviour and falls back to an in-process `Map` when
 * `localStorage` is unavailable (Electron with storage disabled, or tests).
 */
const memory = new Map<string, unknown>()

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const customLocalStorage = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getItem<T = any>(key: string): T | undefined {
    const store = storage()
    if (!store) return memory.get(key) as T | undefined
    try {
      const raw = store.getItem(key)
      return raw === null ? undefined : (JSON.parse(raw) as T)
    } catch {
      return undefined
    }
  },

  setItem(key: string, value: unknown): void {
    const store = storage()
    if (!store) {
      memory.set(key, value)
      return
    }
    try {
      store.setItem(key, JSON.stringify(value))
    } catch {
      memory.set(key, value)
    }
  },

  removeItem(key: string): void {
    memory.delete(key)
    storage()?.removeItem(key)
  },
}

export default customLocalStorage
