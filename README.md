# Beads MCP

A TypeScript HTTP MCP server built from [nickytonline/mcp-typescript-template](https://github.com/nickytonline/mcp-typescript-template). Agents share Beads tasks through eleven tools; Node executes the installed `bd` CLI without a shell.

## Inspiration and intent

This project was inspired by a [livestream with Trillium Smith](https://www.youtube.com/live/Xg1b1NbOicI), where they mentioned building a Beads MCP. Credit to Trillium for the inspiration—and to anyone who explored this idea before them. This project makes no claim to originating the idea of exposing Beads through MCP.

I wanted to build a general-purpose Beads MCP using [my TypeScript MCP template](https://github.com/nickytonline/mcp-typescript-template): a starting point that anyone can use, adapt, and extend for their own agents and workflows. Beads itself was created by [Steve Yegge](https://github.com/steveyegge).

## Architecture

```text
Agents → HTTPS ingress → TypeScript MCP + bd → embedded Dolt on a PVC
```

One server process, one replica, one process-wide FIFO queue for **all** Beads commands, including reads and compound operations. Embedded Dolt is a single-writer store. Do not run another MCP instance, CLI process, or backup job against it concurrently. The queue has a 100-operation admission limit; each CLI subprocess has a 30-second timeout and a 4 MiB output limit. A timeout or invalid output can leave a write's outcome uncertain: inspect the task before retrying.

Transport uses the template's stateless Streamable HTTP adapter at `/mcp`. `GET /health` checks process liveness; startup verifies the initialized store before listening. Health does not continuously query the database. Logs omit task inputs and subprocess stderr.

## Tools

| Tool | Purpose |
| --- | --- |
| `ready` | List unblocked work, with optional priority/label filters |
| `search` | Search text and status/assignee/label filters, including closed tasks |
| `get` | Task details, dependencies, and comment bodies, plus `state_revision`, `activity_revision` and `last_activity_at` |
| `create` | Task, acceptance criteria, priority, labels, optional parent/prerequisites |
| `update` | Edit fields, status, or labels; optional `expected_revision` compare-and-swap |
| `claim` | Native atomic `bd update --claim`, attributed to an actor |
| `release` | Verify ownership, optionally append a reason, clear assignee, set open |
| `add_note` | Append a comment |
| `link` | Add/remove a relationship; for blocks, `id` depends on `target` |
| `complete` | Close with summary/evidence; respects Beads gates/dependencies |
| `handoff` | Append structured done/remaining/next context; optionally release |

Every request to `/mcp` requires a verified signed JWT. The authenticated actor is derived from the configured claim (normally `email`, falling back to `sub`) and is used for every write; optional `actor` fields remain only for client compatibility and are ignored for authenticated HTTP requests. Claims never expire: ownership lasts until `release`, `handoff` with `release`, or `complete`. `update`, `release`, `handoff` and `complete` accept an optional `expected_revision` (the `state_revision` from `get`) for compare-and-swap; without it, writes are last-writer-wins. Compound operations are serialized but are not atomic database transactions; notes may persist if a subsequent release fails. Handoff returns a warning in that case. Results use `{ data: <native Beads JSON> }`; genuine failures have `isError: true` and a body of `{ error, code, retryable, outcome_unknown }`. See [docs/GUARANTEES.md](docs/GUARANTEES.md) for exactly what is guaranteed, what is tested, and what is still unverified.

## Agent skill discovery

The server bundles the canonical [Beads engineering-backlog Agent Skill](skills/beads-engineering-backlog/SKILL.md). It explains when persistent engineering context is useful, how agents should search, claim, note, hand off, and complete work, and where Beads stops: it is not a personal to-do list, memory store, scheduler, orchestrator, or replacement for GitHub Issues.

On protocol revision `2026-07-28` or later, `server/discover` advertises the stable `io.modelcontextprotocol/skills` extension. Clients that support the extension can call `skills/list` or `skills/get` for `skill://beads-engineering-backlog/SKILL.md`, then read the same bytes through `resources/read`. The listing includes a complete file manifest with SHA-256 digests and byte sizes, plus `ttlMs` and `cacheScope` freshness hints. This release does not advertise optional directory reads. Clients that do not support the extension can use the URI in the server instructions or install the standalone `SKILL.md` manually.

Skill content is bundled from the same repository revision into the npm package and container image. There is no separate public skill version: immutable releases use the MCP package/image version, while mutable hosted deployments and client caches may update on their own schedule. A digest match checks consistency between a manifest and fetched bytes; it is not a trust anchor. Reading a resource does not automatically activate the skill, and support has not been assumed for every client—hosts must verify, approve, and load skills through their own supported path.

See [docs/AGENT_SKILLS.md](docs/AGENT_SKILLS.md) for the protocol, security, caching, and compatibility notes.

## Local development

Requires Node 24+ and Beads CLI 1.3.1 (the container pins this tested release). Use an existing initialized store, or initialize a fresh one:

```sh
npm ci
mkdir -p /tmp/beads-project
cd /tmp/beads-project
bd init --prefix=task --skip-agents --skip-hooks --non-interactive
# Return to this repository, then:
BEADS_PROJECT_DIR=/tmp/beads-project npm run dev
```

Connect a client to `http://localhost:3000/mcp` and send a signed JWT in the configured identity header. The server verifies the JWT signature using the configured JWKS URL and validates issuer, audience, and expiration in every environment.

| Environment | Default | Purpose |
| --- | --- | --- |
| `BEADS_PROJECT_DIR` | Current directory; `/data/project` in image | CLI working directory |
| `BEADS_DIR` | `<project>/.beads` | Store directory; use an absolute path |
| `BD_BIN` | `bd` | CLI executable |
| `BD_SERVE_URL` | unset | Opt in to the `bd serve` HTTP executor, for example `http://127.0.0.1:8742` |
| `BD_SERVE_TIMEOUT_MS` | 30000 | HTTP request timeout in milliseconds |
| `BD_SERVE_AUTH_TOKEN_FILE` | unset | Optional bearer-token file for a non-loopback `bd serve` endpoint |
| `DOLT_ROOT_PATH` | Dolt default | Writable Dolt config root |
| `PORT` | 3000 | HTTP port |
| `NODE_ENV` | development | Template environment setting |
| `SERVER_NAME` / `SERVER_VERSION` | package metadata | MCP identity |
| `LOG_LEVEL` | info | error/warn/info/debug |
| `AUTH_JWT_HEADER` | `X-Authenticated-JWT` | Header carrying the signed JWT; `Bearer` prefixes are accepted |
| `AUTH_JWKS_URL` | Required | JWKS endpoint used to verify signatures |
| `AUTH_ISSUER` | Required | Expected JWT issuer |
| `AUTH_AUDIENCE` | Required | Expected JWT audience |
| `AUTH_ACTOR_CLAIM` | `email` | JWT claim used for Beads attribution, falling back to `sub` |

The image initializes missing stores at startup using Beads' own `--init-if-missing` check. It then verifies store access before listening. Initialization never forces or deletes existing data. Local startup expects an already initialized store.

## Verification

```sh
npm run lint
npm run format:check
npm run build
npm run test:ci
BD_BIN=/path/to/bd npm run test:beads
BD_BIN=/path/to/pinned/bd npm run test:beads-http
```

The opt-in live test initializes an isolated embedded store and exercises all eleven tools through the HTTP MCP transport, including competing claims, ownership, handoff, and dependency unblocking. Normal tests need no installed Beads executable.

## Latency benchmark

```sh
npm run bench
```

`src/bench-latency.ts` drives representative read (`get`, `search`) and write (`create`, `update`) tool calls through `registerTools()` — the same wiring the server and tests use — both sequentially and with 10 concurrent reads per batch, and prints p50/p95/p99 latency split into **bd subprocess** time (spent inside the `BeadsCommand` that `BeadsClient` queues) and **MCP overhead** (schema validation, the Effect workflow, JSON-RPC encode/decode, and queue wait).

By default it runs against the in-memory `fake-bd` stand-in used by the test suite, so it needs no `bd` binary and is CI-safe. Point it at a real `bd` executable for live measurement:

```sh
BD_BIN=/path/to/bd BEADS_PROJECT_DIR=/tmp/beads-bench npm run bench
```

In live mode it calls `executeBeads` from `src/beads.ts` directly, so it creates and updates real tasks in the configured store — use a scratch workspace, not a production one. Tune iteration and concurrency counts with `BENCH_ITERATIONS`, `BENCH_CONCURRENCY`, and `BENCH_CONCURRENT_BATCHES`.

## Container

```sh
docker build -t <registry>/beads-mcp:0.1.0 .
```

After building, run `node scripts/smoke-container.mjs <image>` to verify initialization, JWT authentication, tool discovery, actor attribution, and persistence across container replacement. The smoke test requires Docker and the development dependencies and removes its temporary containers and volume.

Build supports linux/amd64 and linux/arm64. The release downloader honors proxy environment variables and verifies the Beads archive against release checksums. For a build environment with a custom proxy CA, pass `--secret id=proxy_ca,src=/path/to/ca.pem`. TLS verification stays enabled.

Back up with `bd backup` during exclusive maintenance access; stop the MCP and wait for its pod to terminate before accessing embedded storage. Preserve the PVC. `.beads/issues.jsonl` is an export, not the source of truth or a backup. Do not concurrently mount the store in a backup CronJob. Beads' [Dolt guide](https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md) covers storage and migration.

## Running multiple MCP replicas

The shipped container entrypoint uses **embedded mode** and supports **one replica**. Increasing `replicas` or adding an HPA against the embedded store is not supported. The in-process queue coordinates requests inside one pod only.

For multiple replicas, use Beads **server mode**:

```text
Agents → HTTPS ingress → MCP pods (each with bd) → Dolt SQL service → database PVC
```

Set up a separate, persistent `dolt sql-server` service. Each MCP pod runs its own TypeScript server and `bd` executable, configured to connect to the **same database**. The database PVC belongs to the Dolt service; MCP pods must not share an embedded database directory. Multiple MCP replicas do not by themselves make Dolt highly available.

Before enabling replicas:

1. Stop the embedded deployment and back up with `bd backup`. Follow the pinned Beads version's migration/restore procedure to move the existing data into server mode. Verify task counts, dependencies, and claims before retiring the original volume.
2. Replace the embedded initialization in `scripts/entrypoint.sh` with server-mode setup using `bd init --server` and the appropriate `--server-host`, `--server-port`, and `--server-user` settings. Provision the shared database once; subsequent pods should open its existing state. Configure database credentials and TLS through Beads' supported settings and your cluster's secret management. Each pod needs its own workspace/configuration, pointing to that same database.
3. Configure the external Dolt service and per-pod settings. Remove the shared embedded-store volume from MCP pods, then configure multiple replicas and an appropriate rollout strategy. Keep database access private to the cluster.
4. Make ownership-sensitive compound operations safe across pods. `release` and `handoff` currently check the assignee and then perform separate writes under a **local** queue. That check can become stale when another pod writes concurrently; use database-backed conditional operations or distributed coordination before promising ownership enforcement across replicas. Native Beads atomic claims remain the primitive for `claim`.
5. Test competing claims, concurrent updates, release/handoff races, pod replacement, and database backup/restore against the shared server before routing production traffic to multiple replicas.

This is the upgrade path, not a server-mode deployment included in the current release. See Beads' [Dolt backend guide](https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md) for connection, storage, and migration details.

## Running in HTTP execution mode (optional)

The default deployment remains embedded Dolt with one MCP replica. For lower
per-call latency, opt in to the stable external-Dolt `--server` backend and
`bd serve`:

```text
MCP container ── localhost ── bd serve sidecar ── pod network ── Dolt SQL server
```

The MCP container sets `BD_SERVE_URL=http://127.0.0.1:8742`. The sidecar runs
the same image with `bd serve --addr=127.0.0.1:8742`; both containers share a
network namespace, so the HTTP endpoint stays loopback-only and needs no auth
token. The Dolt SQL server is a separately operated service with its own
persistent storage. Protect that cross-pod connection with TLS or an mTLS
service mesh and, where the cluster uses default-deny policies, allow only the
sidecar-to-Dolt traffic.

This mode is default-off and does not change the MCP tool schemas, FIFO queue,
error codes, or client-computed revision/CAS behavior. It does require a
server-mode workspace and a migration/rollback plan for data currently in
embedded Dolt. Do not point `BD_SERVE_URL` at a shared public endpoint unless
you configure authentication and transport security.

### Docker Compose

Use three services: the MCP app, a `bd serve` sidecar, and an operator-managed
Dolt SQL server. The example uses placeholders for the pinned image and Dolt
credentials; replace them with your deployment's versioned values.

```yaml
services:
  dolt-sql:
    image: <pinned-dolt-sql-server-image>
    # Persist Dolt data and configure TLS/credentials here.

  bd-serve:
    image: <registry>/beads-mcp:<tag>
    environment:
      BEADS_PROJECT_DIR: /data/project
      BEADS_DIR: /data/project/.beads
      BD_SERVE_URL: http://127.0.0.1:8742
    volumes:
      - bd-workspace:/data/project
    depends_on:
      - dolt-sql
    command: >-
      sh -ec 'bd init --init-if-missing --server
      --server-host=dolt-sql --server-port=3306
      --server-user=$$DOLT_USER --server-password=$$DOLT_PASSWORD
      --prefix=task --skip-agents --skip-hooks --non-interactive
      && exec bd serve --addr=127.0.0.1:8742'

  mcp:
    image: <registry>/beads-mcp:<tag>
    network_mode: service:bd-serve
    environment:
      BD_SERVE_URL: http://127.0.0.1:8742
      BD_SERVE_TIMEOUT_MS: 30000
    depends_on:
      - bd-serve

volumes:
  bd-workspace:
```

Initialize the server-mode workspace once, verify task/dependency counts and
claims, then run the MCP service with `BD_SERVE_URL` set. Compose has no
NetworkPolicy equivalent; keep the project network private and configure TLS
for the Dolt connection.

### Kubernetes

Run the MCP app and `bd serve` as containers in the same Pod. Use an `emptyDir`
or dedicated small volume for the sidecar's Beads workspace metadata; the
authoritative data belongs to the separate Dolt SQL server's persistent volume.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: beads-mcp
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: mcp
          image: <registry>/beads-mcp:<tag>
          env:
            - name: BD_SERVE_URL
              value: http://127.0.0.1:8742
            - name: BD_SERVE_TIMEOUT_MS
              value: "30000"
          ports:
            - containerPort: 3000
        - name: bd-serve
          image: <registry>/beads-mcp:<tag>
          command: ["/bin/sh", "-ec"]
          args:
            - >-
              bd init --init-if-missing --server
              --server-host=dolt-sql --server-port=3306
              --server-user="$DOLT_USER"
              --server-password="$DOLT_PASSWORD"
              --prefix=task --skip-agents --skip-hooks
              --non-interactive
              && exec bd serve --addr=127.0.0.1:8742
          env:
            - name: BD_SERVE_URL
              value: http://127.0.0.1:8742
            - name: DOLT_USER
              valueFrom:
                secretKeyRef: {name: dolt-credentials, key: user}
            - name: DOLT_PASSWORD
              valueFrom:
                secretKeyRef: {name: dolt-credentials, key: password}
          volumeMounts:
            - name: bd-workspace
              mountPath: /data/project
      volumes:
        - name: bd-workspace
          emptyDir: {}
```

Deploy the Dolt SQL server separately as a StatefulSet/Service with pinned
versions, persistent storage, credentials, backups, and TLS. The MCP-to-
`bd serve` hop is loopback and does not need a NetworkPolicy. If the cluster
uses default-deny policies, add a policy allowing only the `bd-serve` container
to connect to the Dolt SQL Service on its SQL/TLS port. Keep `replicas: 1` until
cross-pod ownership races and database-backed conditional writes have been
validated; HTTP execution mode and multi-replica scaling are separate concerns.
