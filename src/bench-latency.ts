/**
 * Latency benchmark harness for MCP tool calls.
 *
 * Drives representative read (`get`, `search`) and write (`create`,
 * `update`) tool calls through the same `registerTools()` wiring the server
 * and tests use, both sequentially and concurrently, and reports p50/p95/p99
 * latency split into "bd subprocess" time (spent inside the `BeadsCommand`
 * that `BeadsClient` queues) and "MCP overhead" (everything else: schema
 * validation, the Effect workflow, JSON-RPC encode/decode, and the
 * in-process queue wait).
 *
 * Defaults to the in-memory `fake-bd` stand-in, so it needs no `bd` binary
 * and is safe to run in CI. Set `BD_BIN` to point at a real `bd` executable
 * to measure against a live subprocess instead (see README.md).
 *
 * Usage:
 *   npm run bench
 *   BD_BIN=/path/to/bd BEADS_PROJECT_DIR=/tmp/beads-bench npm run bench
 *
 * `npm run bench` passes `--experimental-transform-types`: `src/beads.ts`
 * uses TypeScript parameter properties, which Node's default strip-only
 * mode (as used by `npm run dev`) rejects. Pass the same flag if invoking
 * this file directly with `node`.
 *
 * Tuning (optional):
 *   BENCH_ITERATIONS=30         sequential calls per phase
 *   BENCH_CONCURRENCY=10        concurrent calls per batch
 *   BENCH_CONCURRENT_BATCHES=5  batches of concurrent calls
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.ts";
import { BeadsClient, executeBeads, type BeadsCommand } from "./beads.ts";
import { createFakeBd } from "./test-support/fake-bd.ts";

type CallToolParams = Parameters<Client["callTool"]>[0];

interface ToolCallResult {
  structuredContent?: { data?: Record<string, unknown> };
  isError?: boolean;
}

interface Sample {
  totalMs: number;
  bdMs: number;
  overheadMs: number;
}

interface PhaseResult {
  name: string;
  samples: Sample[];
}

/** Carries the running bd-subprocess total for whichever call is in flight. */
const bdTime = new AsyncLocalStorage<{ ms: number }>();

/** Wrap a BeadsCommand so its time is attributed to the in-flight call. */
function instrumentRun(run: BeadsCommand): BeadsCommand {
  return async (args, actor) => {
    const start = performance.now();
    try {
      return await run(args, actor);
    } finally {
      const store = bdTime.getStore();
      if (store) store.ms += performance.now() - start;
    }
  };
}

async function createHarness(run: BeadsCommand) {
  const server = new McpServer({ name: "bench-latency", version: "0.0.0" });
  registerTools(
    server,
    new BeadsClient(instrumentRun(run)).transaction,
    "bench-actor",
  );
  const client = new Client({ name: "bench-latency-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/**
 * Call a tool, timing the full round trip and the share of it spent inside
 * bd subprocess calls (correlated via AsyncLocalStorage, which survives the
 * in-memory transport's promise/queue hops).
 */
async function timedWithResult(
  client: Client,
  params: CallToolParams,
): Promise<{ sample: Sample; result: ToolCallResult }> {
  const store = { ms: 0 };
  const start = performance.now();
  const result = (await bdTime.run(store, () =>
    client.callTool(params),
  )) as ToolCallResult;
  const totalMs = performance.now() - start;
  return {
    result,
    sample: {
      totalMs,
      bdMs: store.ms,
      overheadMs: Math.max(0, totalMs - store.ms),
    },
  };
}

async function timed(client: Client, params: CallToolParams): Promise<Sample> {
  const { sample, result } = await timedWithResult(client, params);
  if (result.isError)
    throw new Error(
      `Tool call "${params.name}" failed: ${JSON.stringify(result)}`,
    );
  return sample;
}

async function runSequential(
  name: string,
  iterations: number,
  run: (iteration: number) => Promise<Sample>,
): Promise<PhaseResult> {
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(await run(i));
  }
  return { name, samples };
}

async function runConcurrent(
  name: string,
  batches: number,
  concurrency: number,
  run: () => Promise<Sample>,
): Promise<PhaseResult> {
  const samples: Sample[] = [];
  for (let b = 0; b < batches; b++) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, () => run()),
    );
    samples.push(...batch);
  }
  return { name, samples };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

function stats(values: number[]) {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

function formatLine(
  label: string,
  s: { p50: number; p95: number; p99: number },
): string {
  const fmt = (ms: number) => `${ms.toFixed(2)}ms`.padStart(9);
  return `  ${label.padEnd(16)} p50=${fmt(s.p50)}  p95=${fmt(s.p95)}  p99=${fmt(s.p99)}`;
}

function printPhase(result: PhaseResult): void {
  const total = stats(result.samples.map((s) => s.totalMs));
  const bd = stats(result.samples.map((s) => s.bdMs));
  const overhead = stats(result.samples.map((s) => s.overheadMs));
  process.stdout.write(`\n${result.name} (n=${result.samples.length})\n`);
  process.stdout.write(formatLine("total", total) + "\n");
  process.stdout.write(formatLine("bd subprocess", bd) + "\n");
  process.stdout.write(formatLine("mcp overhead", overhead) + "\n");
}

async function main(): Promise<void> {
  const live = Boolean(process.env.BD_BIN);
  const iterations = Number(process.env.BENCH_ITERATIONS ?? 30);
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 10);
  const concurrentBatches = Number(process.env.BENCH_CONCURRENT_BATCHES ?? 5);

  process.stdout.write("Beads MCP latency benchmark\n");
  process.stdout.write(
    `mode: ${live ? `live (BD_BIN=${process.env.BD_BIN})` : "fake-bd (in-memory, CI-safe)"}\n`,
  );
  process.stdout.write(
    `iterations: ${iterations} sequential per phase; ${concurrency} x ${concurrentBatches} concurrent reads\n`,
  );

  const run: BeadsCommand = live ? executeBeads : createFakeBd().run;
  const { client, server } = await createHarness(run);

  try {
    const { result: created } = await timedWithResult(client, {
      name: "create",
      arguments: { title: "bench-latency seed task" },
    });
    const seedId = created.structuredContent?.data?.id;
    if (typeof seedId !== "string")
      throw new Error("Failed to seed a task for benchmarking");

    const phases: PhaseResult[] = [];

    phases.push(
      await runSequential("read: get (sequential)", iterations, () =>
        timed(client, { name: "get", arguments: { id: seedId } }),
      ),
    );

    phases.push(
      await runSequential("read: search (sequential)", iterations, () =>
        timed(client, {
          name: "search",
          arguments: { query: "bench-latency" },
        }),
      ),
    );

    phases.push(
      await runSequential("write: create (sequential)", iterations, (i) =>
        timed(client, {
          name: "create",
          arguments: { title: `bench-latency write ${i}` },
        }),
      ),
    );

    phases.push(
      await runSequential("write: update (sequential)", iterations, (i) =>
        timed(client, {
          name: "update",
          arguments: { id: seedId, description: `bench iteration ${i}` },
        }),
      ),
    );

    phases.push(
      await runConcurrent(
        `read: get (${concurrency}x concurrent)`,
        concurrentBatches,
        concurrency,
        () => timed(client, { name: "get", arguments: { id: seedId } }),
      ),
    );

    process.stdout.write("\n=== Results ===\n");
    for (const phase of phases) printPhase(phase);
  } finally {
    await client.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
