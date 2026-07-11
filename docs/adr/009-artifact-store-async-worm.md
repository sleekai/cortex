## ADR-009: ArtifactStore as Async Content-Addressable WORM Storage

**Status:** Accepted

**Context:**
The `ArtifactStore` trait is the sole I/O boundary for artifact persistence. It needs to support async operations, content-addressability, and deduplication.

**Decision:**
The `ArtifactStore` trait is async, write-once-read-many (WORM), and keyed by the caller-computed SHA-256 hash. The trait has two methods: `get(hash: &str) -> Option<Vec<u8>>` and `put(hash: &str, body: Vec<u8>) -> ()`. The caller (the `DirectiveExecutor`) computes the hash before calling `put`. The store may silently ignore duplicate `put` calls for the same hash.

**Consequences:**
- **Positive:** Content-addressability guarantees deduplication. Identical content is stored once regardless of how many times it is produced.
- **Positive:** WORM semantics simplify implementation. No updates, no deletes, no concurrency conflicts on writes.
- **Positive:** Async interface allows disk-backed, network-backed, or in-memory implementations without blocking the kernel loop.
- **Negative:** The caller must compute the hash. This is accepted as the `DirectiveExecutor` already has the bytes in hand during hydration/dehydration.
