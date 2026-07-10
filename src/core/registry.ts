export interface NamedRegistry<T extends { name: string }> {
  register(item: T): void
  get(name: string): T | undefined
  all(): T[]
  clear(): void
}

export function namedRegistry<T extends { name: string }>(): NamedRegistry<T> {
  const items = new Map<string, T>()
  return {
    register: (item) => { items.set(item.name, item) },
    get: (name) => items.get(name),
    all: () => [...items.values()],
    clear: () => items.clear(),
  }
}
