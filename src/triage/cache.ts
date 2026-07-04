// Deterministic decomposition cache (spec §9 "cache repeated decompositions").
// Because every built-in skill is deterministic, a task that normalizes to the
// same string always yields the same packet — so caching the whole packet by
// the normalized task's hash is safe and lets repeated tasks skip re-running
// the skill pipeline entirely.
//
// Process-local by design: an in-memory Map, no persistence. The state layer
// (state/store.ts) owns anything durable; the cache is a pure speedup.
import * as crypto from 'node:crypto'
import { type CTSPacket } from './packet.js'

const cache = new Map<string, CTSPacket>()

export function cacheKey(normalizedTask: string): string {
  return crypto.createHash('sha256').update(normalizedTask).digest('hex')
}

export function getCached(key: string): CTSPacket | undefined {
  return cache.get(key)
}

export function setCached(key: string, packet: CTSPacket): void {
  cache.set(key, packet)
}

export function clearCache(): void {
  cache.clear()
}

export function cacheSize(): number {
  return cache.size
}
