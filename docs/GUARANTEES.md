# Beads MCP guarantees

What this server promises, what it does not, and how each promise is tested.
Scope: one MCP process, one replica, embedded Dolt (the shipped configuration).
The optional `BD_SERVE_URL` mode uses the same process and queue guarantees
against a colocated `bd serve` sidecar and a Dolt SQL server; it is separately
deployed and remains default-off.

## Ownership

- A claim lasts until the owner releases it (`release`, or `handoff` with
  `release: true`) or the task is completed. **Claims never expire.** There is
  no lease, no heartbeat, and no automatic recovery of a claim whose owner
  crashed or disconnected. Recover a stale claim by having the owner (or an
  operator) release it.
- `bd` emits `lease_expires_at` and `heartbeat_at` when a task is claimed. Nothing
  in this server enforces or renews them, so they are removed from every
  response rather than left to suggest a guarantee that does not exist.
- A claim by a different actor fails with `OWNERSHIP_CONFLICT`. Re-claiming your
  own task is a no-op. A contested claim has exactly one winner.
- Only the assignee can `release` or `handoff`. Changing `status` through
  `update`, or calling `complete`, on a task claimed by someone else fails with
  `OWNERSHIP_CONFLICT`. Editing other fields, adding labels, and adding notes
  stay open to everyone.

### Identity authentication

HTTP `/mcp` requests require a signed JWT. The signature is verified against the
configured JWKS URL, and issuer, audience, and expiration are validated. The
Beads actor is normalized from the configured JWT claim, falling back to `sub`.
Caller-supplied `actor` fields remain in tool schemas for compatibility, but
authenticated HTTP writes always use the verified actor from request context.
`/health` is intentionally unauthenticated.

Missing or invalid tokens return HTTP 401 (`Unauthorized`). Unsupported token
algorithms and unknown or ambiguous signing keys also return 401. Failures while
retrieving or importing the provider's JWKS keys return HTTP 503
(`Authentication service unavailable`), including network errors, timeouts,
non-200 responses, invalid JSON, and malformed JWKS documents. Both paths reject
the request before any MCP tool runs, return generic response bodies, and log
verification failures on the server. This corrects the HTTP status for JWKS
provider failures, which previously returned 401; clients should handle 503 as a
service failure that may be retried later.

## Concurrency

- Every `bd` invocation, including reads and the read-then-write sequences
  inside `update`, `release`, `handoff` and `complete`, runs in one FIFO queue.
  A multi-field `update` is applied as one `bd` call and is never interleaved
  with another request.
- `update`, `release`, `handoff` and `complete` accept `expected_revision`
  (the `state_revision` returned by `get`). If the task changed since that
  read, the call fails with `REVISION_CONFLICT`, **modifies nothing**, and the
  error details carry the current revision and current field values so the
  agent can reconcile and retry.
- **Without `expected_revision`, writes are last-writer-wins.** Pass it
  whenever an agent reads, thinks, then writes.
- The check and the write are atomic with respect to other requests through
  this process. They are not a database transaction, and they are not safe
  across multiple replicas (see the README section on replicas).
- In HTTP mode, label edits perform a GET followed by a PATCH of the complete
  labels array. An external writer can change labels between those requests;
  its changes may be overwritten. The HTTP compare-and-swap guarantee excludes
  concurrent label changes from direct CLI users, other HTTP clients, or other
  MCP processes. All revision checks remain local to the MCP queue, rather
  than database-level conditional writes.
- Compound operations are not transactional: `handoff` with `release` records
  the note, then releases. If the release fails the note remains and a warning
  is returned.

## Change detection

`bd`'s `updated_at` does not advance for notes or label changes, so do not poll
it. `get` returns three server-computed fields instead:

| Field | Changes when | Use |
| --- | --- | --- |
| `state_revision` | title, description, acceptance criteria, priority, status, assignee, type, or labels change | Compare-and-swap token for `expected_revision`. Notes and dependency edges do not change it, so they never cause a false conflict. |
| `activity_revision` | anything above, or a note or dependency is added or removed | Poll this to learn that anything changed. |
| `last_activity_at` | newest of `updated_at` and any note timestamp | Human-readable recency. |

Only `get` returns these, because they need the full task including notes.

## Errors

Failed calls return `isError: true` with a structured body:
`{ error, code, retryable, outcome_unknown, details? }`. Branch on `code`.

| `code` | Meaning | `retryable` |
| --- | --- | --- |
| `NOT_FOUND` | No such task | no |
| `INVALID_INPUT` | Request rejected as malformed | no |
| `OWNERSHIP_CONFLICT` | Another actor holds the claim | no |
| `REVISION_CONFLICT` | Task changed since `expected_revision`; nothing modified | no, re-read first |
| `DEPENDENCY_CYCLE` | Link would create a cycle | no |
| `BACKEND_UNAVAILABLE` | Queue full, shutting down, storage busy, or `bd` missing | reads and never-started requests: yes. Writes that may have started: no |
| `OUTCOME_UNCERTAIN` | Timeout or unparsable output | writes: no. Inspect the task first |
| `INTERNAL` | Anything unclassified | reads: yes. Writes: no |

`outcome_unknown: true` means a write may have been applied. The server never
retries a write on its own, and agents should not resend one without reading
the task first. Raw `bd` stderr is used for classification only and is never
returned or logged.

Schema validation failures (bad ID format, empty note, out-of-range priority)
are rejected by the MCP SDK before a handler runs and use the SDK's own error
shape, not the structure above.

## Persistence

Task state lives in embedded Dolt on a persistent volume and survives restarts
and client changes. The in-process queue is memory only: requests in flight
during a crash may or may not have been applied, which is what
`outcome_unknown` is for.

## Performance

The default embedded-Dolt path forks and execs `bd` for every tool call. With
the pinned Beads 1.3.1 binary, the repository benchmark measured approximately
421 ms p50 for a sequential `get`. A Dolt server workspace using per-call CLI
execution measured approximately 99 ms p50; keeping `bd serve` open over
loopback measured approximately 13–15 ms p50.

The lower-latency path is opt-in through `BD_SERVE_URL` and requires the stable
external-Dolt `--server` backend plus a `bd serve` sidecar. The upstream
`--proxied-server` mode remains experimental and is not required by this
implementation. Switching an existing embedded workspace is a data migration
and adds an independently operated Dolt SQL server, so the default remains
embedded mode.

HTTP execution preserves the existing tool schemas, FIFO queue, ownership
rules, error codes, and client-computed revision/CAS contract. HTTP mode plus
multiple MCP replicas is not a verified guarantee; keep one replica until
cross-pod ownership and conditional-write behavior are explicitly tested.

## Verification status

| Claim | Evidence |
| --- | --- |
| Invalid tokens return 401; JWKS retrieval failures return 503; cached keys and outage recovery work | `src/app.auth.test.ts`, real signed JWTs and a local JWKS HTTP endpoint, including provider HTTP errors, invalid JSON, malformed key sets, disconnects, and timeouts |
| Single winner for contested claims and for same-revision writers | `src/hardening.test.ts`, 8 and 20 concurrent callers, assertions on persisted state |
| Stale writes rejected, nothing modified | same file, including races with release and claim |
| Change tokens catch notes, labels, and dependencies | same file, against a fake `bd` that reproduces the `updated_at` quirk |
| Error codes from real subprocess exits | same file, using a stub `bd` executable |
| Each guarantee is load-bearing | fixes were individually disabled and the suite failed each time |

**Unverified**, and not to be claimed as working:

- The stderr patterns in `src/errors.ts` are heuristics. They have not been run
  against the pinned `bd` 1.3.1 binary. Run `npm run test:beads` with `bd`
  installed and extend the live test to assert `NOT_FOUND` for a missing ID
  before trusting `NOT_FOUND`, `OWNERSHIP_CONFLICT` and `DEPENDENCY_CYCLE` in
  production. Unmatched failures degrade safely to `INTERNAL` with an uncertain
  outcome.
- Behaviour with two separately authenticated identities through a production
  identity provider. JWT signature and claim validation are covered by
  `src/auth.test.ts`; the container smoke test uses a temporary signed JWT and
  JWKS endpoint.
- Behaviour after a `bd` lease would have expired, from a second identity.
- Multi-replica deployments, Dolt server mode, and failures mid-write.
- Durability over hours or days. A separate recheck is scheduled.
