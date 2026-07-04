// Reducer channels: the shared-state seam of the state graph. Each channel
// declares how concurrent updates merge (LangGraph-style reducers), so
// parallel nodes never race on state — the executor applies their updates
// through the reducer in deterministic order. Channel values must stay
// JSON-serializable: checkpoints are structuredClone snapshots persisted as
// JSON, and a value that cannot round-trip breaks resume.

export type Reducer<T> = (current: T, update: T) => T

// Method syntax on purpose: methods are bivariant, so a ChannelSpec<T[]>
// slots into a Channels map typed over ChannelSpec<unknown>.
export interface ChannelSpec<T = unknown> {
  reducer(current: T, update: T): T
  initial(): T
}

export type Channels = Record<string, ChannelSpec>

// The runtime state a graph run threads through its nodes: one value per
// declared channel, nothing else. Unknown keys in a node update are a
// programming error and fail loud (see applyUpdate).
export type GraphState = Record<string, unknown>

// Overwrite semantics — the classic "last value wins" channel.
export function lastValue<T>(initial: T): ChannelSpec<T> {
  return { reducer: (_current, update) => update, initial: () => initial }
}

// Append semantics — updates are arrays concatenated onto the current list.
export function appendList<T>(): ChannelSpec<T[]> {
  return { reducer: (current, update) => [...current, ...update], initial: () => [] }
}

// Keyed merge semantics — updates are records shallow-merged over the
// current map; later writers win per key.
export function mapMerge<T>(): ChannelSpec<Record<string, T>> {
  return { reducer: (current, update) => ({ ...current, ...update }), initial: () => ({}) }
}

export function channel<T>(initial: T, reducer: Reducer<T>): ChannelSpec<T> {
  return { reducer, initial: () => initial }
}

export function initialState(channels: Channels): GraphState {
  const state: GraphState = {}
  for (const [key, spec] of Object.entries(channels)) {
    state[key] = spec.initial()
  }
  return state
}

// Apply one node's update to the state through the channel reducers.
// Mutates nothing: returns a fresh state object.
export function applyUpdate(
  channels: Channels,
  state: GraphState,
  update: Record<string, unknown>,
): GraphState {
  const next: GraphState = { ...state }
  for (const [key, value] of Object.entries(update)) {
    const spec = channels[key]
    if (!spec) {
      throw new Error(`graph: update targets unknown channel "${key}"`)
    }
    next[key] = spec.reducer(next[key], value)
  }
  return next
}
