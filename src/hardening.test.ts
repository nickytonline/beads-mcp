import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { BeadsClient, executeBeads } from "./beads.ts";
import { BeadsError, classifyFailure } from "./errors.ts";
import { stateRevision, stripLeaseMetadata } from "./revision.ts";
import { createFakeBd } from "./test-support/fake-bd.ts";
import { registerTools } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Out = { isError: boolean; body: any };

let harness: { client: Client; server: McpServer } | undefined;
afterEach(async () => {
  await harness?.client.close();
  await harness?.server.close();
  harness = undefined;
  vi.unstubAllEnvs();
});

async function setup(authenticatedActor?: string) {
  const fake = createFakeBd();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(
    server,
    new BeadsClient(fake.run).transaction,
    authenticatedActor,
  );
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  harness = { client, server };

  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Out> {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, body: result.structuredContent };
  }
  async function create(extra: Record<string, unknown> = {}) {
    const created = await call("create", {
      title: "task",
      actor: "owner",
      ...extra,
    });
    expect(created.isError).toBe(false);
    return created.body.data.id as string;
  }
  async function get(id: string) {
    const got = await call("get", { id });
    expect(got.isError).toBe(false);
    return got.body.data[0] as Record<string, any>;
  }
  return { fake, call, create, get };
}

describe("change detection", () => {
  it("uses the verified actor instead of a compatibility actor field", async () => {
    const { call, create, fake } = await setup("verified@example.com");
    const id = await create({ actor: "spoofed@example.com" });

    await call("claim", { id, actor: "spoofed@example.com" });
    await call("add_note", { id, actor: "spoofed@example.com", note: "note" });

    expect(fake.peek(id)?.assignee).toBe("verified@example.com");
    expect(fake.peek(id)?.comments?.[0]?.author).toBe("verified@example.com");
  });

  it("advances activity_revision for a note even though bd's updated_at does not", async () => {
    const { call, create, get } = await setup();
    const id = await create();
    const before = await get(id);
    await call("add_note", { id, actor: "a", note: "finding" });
    const after = await get(id);

    expect(after.updated_at).toBe(before.updated_at); // the bd quirk being worked around
    expect(after.activity_revision).not.toBe(before.activity_revision);
    expect(Date.parse(after.last_activity_at)).toBeGreaterThan(
      Date.parse(before.last_activity_at),
    );
    expect(after.state_revision).toBe(before.state_revision);
  });

  it("advances both revisions for a label change that bd's updated_at also misses", async () => {
    const { call, create, get } = await setup();
    const id = await create();
    const before = await get(id);
    await call("update", { id, actor: "a", "add-label": "urgent" });
    const after = await get(id);

    expect(after.updated_at).toBe(before.updated_at);
    expect(after.state_revision).not.toBe(before.state_revision);
    expect(after.activity_revision).not.toBe(before.activity_revision);
  });

  it("returns identical tokens when nothing changed", async () => {
    const { create, get } = await setup();
    const id = await create();
    const first = await get(id);
    const second = await get(id);
    expect(second.state_revision).toBe(first.state_revision);
    expect(second.activity_revision).toBe(first.activity_revision);
    expect(second.last_activity_at).toBe(first.last_activity_at);
  });

  it("advances activity_revision when a dependency is added", async () => {
    const { call, create, get } = await setup();
    const a = await create();
    const b = await create();
    const before = await get(a);
    expect(
      (await call("link", { id: a, target: b, actor: "x", action: "add" }))
        .isError,
    ).toBe(false);
    const after = await get(a);
    expect(after.activity_revision).not.toBe(before.activity_revision);
    expect(after.state_revision).toBe(before.state_revision);
  });
});

describe("compare-and-swap updates", () => {
  it("applies a write with the current revision and persists it", async () => {
    const { call, create, get, fake } = await setup();
    const id = await create();
    const { state_revision } = await get(id);
    const result = await call("update", {
      id,
      actor: "a",
      description: "fresh",
      expected_revision: state_revision,
    });
    expect(result.isError).toBe(false);
    expect(fake.peek(id)?.description).toBe("fresh");
  });

  it("rejects a stale write with REVISION_CONFLICT, changes nothing, and allows a safe retry", async () => {
    const { call, create, get, fake } = await setup();
    const id = await create({ description: "original" });
    const stale = (await get(id)).state_revision;

    // Another agent edits first.
    await call("update", { id, actor: "b", description: "b was here" });

    const rejected = await call("update", {
      id,
      actor: "a",
      description: "a's overwrite",
      expected_revision: stale,
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.body).toMatchObject({
      code: "REVISION_CONFLICT",
      retryable: false,
      outcome_unknown: false,
      details: {
        expected_revision: stale,
        current: { description: "b was here" },
      },
    });
    expect(fake.peek(id)?.description).toBe("b was here"); // b's write survived

    const fresh = rejected.body.details.current_revision;
    expect(fresh).toBe((await get(id)).state_revision);
    const retried = await call("update", {
      id,
      actor: "a",
      description: "a, reconciled",
      expected_revision: fresh,
    });
    expect(retried.isError).toBe(false);
    expect(fake.peek(id)?.description).toBe("a, reconciled");
  });

  it("lets exactly one of many concurrent writers holding the same revision win", async () => {
    const { call, create, get, fake } = await setup();
    const id = await create({ description: "start" });
    const { state_revision } = await get(id);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call("update", {
          id,
          actor: `agent-${i}`,
          description: `writer-${i}`,
          expected_revision: state_revision,
        }),
      ),
    );

    const winners = results.flatMap((r, i) => (r.isError ? [] : [i]));
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((r) => r.isError))
      expect(loser.body.code).toBe("REVISION_CONFLICT");
    expect(fake.peek(id)?.description).toBe(`writer-${winners[0]}`);
  });

  it("without expected_revision stays last-writer-wins but never tears a multi-field write", async () => {
    const { call, create, fake } = await setup();
    const id = await create();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call("update", {
          id,
          actor: `agent-${i}`,
          title: `t${i}`,
          description: `d${i}`,
        }),
      ),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    const final = fake.peek(id)!;
    expect(final.title.slice(1)).toBe(final.description!.slice(1)); // same writer
  });

  it("does not raise a false conflict when only a note was added in between", async () => {
    const { call, create, get, fake } = await setup();
    const id = await create();
    const { state_revision } = await get(id);
    await call("add_note", { id, actor: "b", note: "unrelated" });
    const result = await call("update", {
      id,
      actor: "a",
      description: "still fine",
      expected_revision: state_revision,
    });
    expect(result.isError).toBe(false);
    expect(fake.peek(id)?.description).toBe("still fine");
  });

  it("raises a conflict when a label changed in between", async () => {
    const { call, create, get } = await setup();
    const id = await create();
    const { state_revision } = await get(id);
    await call("update", { id, actor: "b", "add-label": "x" });
    const result = await call("update", {
      id,
      actor: "a",
      description: "late",
      expected_revision: state_revision,
    });
    expect(result.body.code).toBe("REVISION_CONFLICT");
  });

  it("rejects a stale write that raced a release", async () => {
    const { call, create, get, fake } = await setup();
    const id = await create();
    await call("claim", { id, actor: "a" });
    const stale = (await get(id)).state_revision;
    await call("release", { id, actor: "a" });
    const result = await call("update", {
      id,
      actor: "a",
      description: "after release",
      expected_revision: stale,
    });
    expect(result.body.code).toBe("REVISION_CONFLICT");
    expect(fake.peek(id)).toMatchObject({ status: "open" });
    expect(fake.peek(id)?.assignee).toBeUndefined();
  });

  it("leaves a consistent task when an update races a claim, in either order", async () => {
    const { call, create, get, fake } = await setup();
    const id = await create();
    const { state_revision } = await get(id);
    const [update, claim] = await Promise.all([
      call("update", {
        id,
        actor: "a",
        status: "blocked",
        expected_revision: state_revision,
      }),
      call("claim", { id, actor: "b" }),
    ]);
    expect(claim.isError).toBe(false);
    expect(fake.peek(id)).toMatchObject({
      assignee: "b",
      status: "in_progress",
    });
    if (update.isError)
      expect(["REVISION_CONFLICT", "OWNERSHIP_CONFLICT"]).toContain(
        update.body.code,
      );
  });

  it("applies CAS to release, handoff and complete too", async () => {
    const { call, create, get, fake } = await setup();
    const id = await create();
    await call("claim", { id, actor: "a" });
    const stale = (await get(id)).state_revision;
    await call("update", { id, actor: "a", description: "moved on" });

    const common = { id, actor: "a", expected_revision: stale };
    const release = await call("release", common);
    const handoff = await call("handoff", {
      ...common,
      done: "d",
      remaining: "r",
      next: "n",
    });
    const complete = await call("complete", { ...common, summary: "s" });
    for (const r of [release, handoff, complete])
      expect(r.body.code).toBe("REVISION_CONFLICT");
    expect(fake.peek(id)).toMatchObject({
      status: "in_progress",
      assignee: "a",
      comment_count: 0,
    });
  });

  it("rejects a malformed expected_revision before touching storage", async () => {
    const { call, create, fake } = await setup();
    const id = await create();
    const before = fake.commands.length;
    const result = await call("update", {
      id,
      actor: "a",
      description: "x",
      expected_revision: "nope",
    });
    expect(result.isError).toBe(true);
    expect(fake.commands.length).toBe(before);
  });
});

describe("ownership", () => {
  it("grants a contested claim to exactly one of many actors", async () => {
    const { call, create, fake } = await setup();
    const id = await create();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call("claim", { id, actor: `agent-${i}` }),
      ),
    );
    const winners = results.flatMap((r, i) => (r.isError ? [] : [i]));
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((r) => r.isError))
      expect(loser.body).toMatchObject({
        code: "OWNERSHIP_CONFLICT",
        retryable: false,
      });
    expect(fake.peek(id)?.assignee).toBe(`agent-${winners[0]}`);
  });

  it("stops other actors from changing status, completing, releasing, or handing off", async () => {
    const { call, create, fake } = await setup();
    const id = await create();
    await call("claim", { id, actor: "a" });
    const snapshot = JSON.stringify(fake.peek(id));

    const attempts = await Promise.all([
      call("update", { id, actor: "b", status: "open" }),
      call("complete", { id, actor: "b", summary: "stolen" }),
      call("release", { id, actor: "b" }),
      call("handoff", {
        id,
        actor: "b",
        done: "d",
        remaining: "r",
        next: "n",
        release: true,
      }),
    ]);
    for (const attempt of attempts)
      expect(attempt.body.code).toBe("OWNERSHIP_CONFLICT");
    expect(JSON.stringify(fake.peek(id))).toBe(snapshot); // nothing moved, no note written
  });

  it("still lets other actors edit non-status fields and add notes on a claimed task", async () => {
    const { call, create, fake } = await setup();
    const id = await create();
    await call("claim", { id, actor: "a" });
    expect(
      (await call("update", { id, actor: "b", description: "context" }))
        .isError,
    ).toBe(false);
    expect(
      (await call("add_note", { id, actor: "b", note: "hi" })).isError,
    ).toBe(false);
    expect(fake.peek(id)).toMatchObject({
      description: "context",
      assignee: "a",
      comment_count: 1,
    });
  });

  it("lets the owner complete, and an unclaimed task be completed by anyone", async () => {
    const { call, create, fake } = await setup();
    const owned = await create();
    await call("claim", { id: owned, actor: "a" });
    expect(
      (await call("complete", { id: owned, actor: "a", summary: "done" }))
        .isError,
    ).toBe(false);
    expect(fake.peek(owned)?.status).toBe("closed");

    const free = await create();
    expect(
      (await call("complete", { id: free, actor: "z", summary: "done" }))
        .isError,
    ).toBe(false);
  });

  it("makes claims permanent until released, and exposes no lease metadata", async () => {
    const { call, create, get } = await setup();
    const id = await create();
    const claimed = await call("claim", { id, actor: "a" });
    const read = await call("get", { id });
    const updated = await call("update", { id, actor: "a", "add-label": "x" });
    for (const out of [claimed, read, updated])
      expect(JSON.stringify(out.body)).not.toMatch(
        /lease_expires_at|heartbeat_at/,
      );

    expect((await call("claim", { id, actor: "a" })).isError).toBe(false); // idempotent
    expect((await call("claim", { id, actor: "b" })).body.code).toBe(
      "OWNERSHIP_CONFLICT",
    );
    expect((await get(id)).assignee).toBe("a");

    await call("release", { id, actor: "a" });
    expect((await call("claim", { id, actor: "b" })).isError).toBe(false);
  });
});

describe("error contract", () => {
  it("returns NOT_FOUND for every tool that takes an id", async () => {
    const { call } = await setup();
    const id = "task-missing";
    const outcomes = await Promise.all([
      call("get", { id }),
      call("update", { id, actor: "a", description: "x" }),
      call("claim", { id, actor: "a" }),
      call("add_note", { id, actor: "a", note: "x" }),
      call("release", { id, actor: "a" }),
      call("complete", { id, actor: "a", summary: "x" }),
      call("handoff", { id, actor: "a", done: "d", remaining: "r", next: "n" }),
    ]);
    for (const out of outcomes)
      expect(out.body).toMatchObject({
        code: "NOT_FOUND",
        retryable: false,
        outcome_unknown: false,
      });
  });

  it("returns DEPENDENCY_CYCLE for a circular link and leaves the graph intact", async () => {
    const { call, create, get } = await setup();
    const a = await create();
    const b = await create();
    await call("link", { id: a, target: b, actor: "x", action: "add" });
    const cycle = await call("link", {
      id: b,
      target: a,
      actor: "x",
      action: "add",
    });
    expect(cycle.body.code).toBe("DEPENDENCY_CYCLE");
    expect((await get(b)).dependency_count).toBe(0);
  });

  it("returns INVALID_INPUT for an update with no fields", async () => {
    const { call, create } = await setup();
    const id = await create();
    expect((await call("update", { id, actor: "a" })).body.code).toBe(
      "INVALID_INPUT",
    );
  });

  it("keeps serving requests after failures", async () => {
    const { call, create, get } = await setup();
    const id = await create();
    await call("get", { id: "task-missing" });
    await call("claim", { id, actor: "a" });
    await call("claim", { id, actor: "b" });
    expect((await get(id)).assignee).toBe("a");
  });

  it("classifies failures without leaking stderr and without inviting unsafe retries", () => {
    const secret = "SECRET-TOKEN-123";
    const cases = [
      {
        in: { stderr: `issue not found: ${secret}`, code: 1, write: false },
        code: "NOT_FOUND",
      },
      {
        in: { stderr: `would create a cycle ${secret}`, code: 1, write: true },
        code: "DEPENDENCY_CYCLE",
      },
      {
        in: { stderr: `already claimed by x ${secret}`, code: 1, write: true },
        code: "OWNERSHIP_CONFLICT",
      },
      {
        in: { stderr: `unknown flag --x ${secret}`, code: 1, write: true },
        code: "INVALID_INPUT",
      },
      { in: { code: "ENOENT", write: true }, code: "BACKEND_UNAVAILABLE" },
    ] as const;
    for (const c of cases) {
      const error = classifyFailure(c.in);
      expect(error.code).toBe(c.code);
      expect(error.message).not.toContain(secret);
    }

    const writeTimeout = classifyFailure({ killed: true, write: true });
    expect(writeTimeout).toMatchObject({
      code: "OUTCOME_UNCERTAIN",
      retryable: false,
      outcomeUnknown: true,
    });
    const readTimeout = classifyFailure({ killed: true, write: false });
    expect(readTimeout).toMatchObject({
      retryable: true,
      outcomeUnknown: false,
    });

    const lockedWrite = classifyFailure({
      stderr: "database is locked",
      code: 1,
      write: true,
    });
    expect(lockedWrite).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: false,
      outcomeUnknown: true,
    });
    const lockedRead = classifyFailure({
      stderr: "database is locked",
      code: 1,
      write: false,
    });
    expect(lockedRead).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });

    const unknownWrite = classifyFailure({
      stderr: secret,
      code: 2,
      write: true,
    });
    expect(unknownWrite).toMatchObject({
      code: "INTERNAL",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(unknownWrite.message).not.toContain(secret);
  });

  it("rejects work after shutdown as a retryable BACKEND_UNAVAILABLE that ran nothing", async () => {
    const fake = createFakeBd();
    const queue = new BeadsClient(fake.run);
    await queue.drain();
    const error: unknown = await queue
      .transaction((run) => run(["ready"]))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BeadsError);
    expect(error).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
      outcomeUnknown: false,
    });
    expect(fake.commands).toHaveLength(0);
  });
});

describe("subprocess boundary (executeBeads)", () => {
  function fakeBinary() {
    const dir = mkdtempSync(join(tmpdir(), "fake-bd-"));
    const bin = join(dir, "bd");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("missing")) { console.error("issue not found: SECRET-TOKEN-123"); process.exit(1); }
if (args.includes("badjson")) { console.log("not json"); process.exit(0); }
console.log(JSON.stringify(args));
`,
    );
    chmodSync(bin, 0o755);
    vi.stubEnv("BD_BIN", bin);
    vi.stubEnv("BEADS_PROJECT_DIR", dir);
    return dir;
  }

  it("passes --json and --actor and returns parsed output", async () => {
    const dir = fakeBinary();
    try {
      expect(await executeBeads(["show", "task-1"], "agent-1")).toEqual([
        "--json",
        "--actor=agent-1",
        "show",
        "task-1",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps non-zero exits to typed errors from real stderr without echoing it", async () => {
    const dir = fakeBinary();
    try {
      const error = await executeBeads(["show", "missing"]).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "NOT_FOUND", retryable: false });
      expect((error as Error).message).not.toContain("SECRET-TOKEN-123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unparsable output from a write as outcome-unknown and non-retryable", async () => {
    const dir = fakeBinary();
    try {
      const error = await executeBeads(["update", "task-1", "badjson"]).catch(
        (e) => e,
      );
      expect(error).toMatchObject({
        code: "OUTCOME_UNCERTAIN",
        retryable: false,
        outcomeUnknown: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing executable as BACKEND_UNAVAILABLE", async () => {
    vi.stubEnv("BD_BIN", "/nonexistent/bd");
    const error = await executeBeads(["ready"]).catch((e) => e);
    expect(error).toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });
});

describe("revision helpers", () => {
  it("ignores label order and unrelated fields", () => {
    const base = {
      title: "t",
      status: "open",
      priority: 2,
      labels: ["b", "a"],
    };
    expect(stateRevision(base)).toBe(
      stateRevision({
        ...base,
        labels: ["a", "b"],
        updated_at: "x",
        comment_count: 9,
      }),
    );
    expect(stateRevision(base)).not.toBe(
      stateRevision({ ...base, priority: 1 }),
    );
  });

  it("strips lease metadata at any depth", () => {
    expect(
      stripLeaseMetadata({
        a: [{ lease_expires_at: "x", keep: 1, n: { heartbeat_at: "y" } }],
      }),
    ).toEqual({ a: [{ keep: 1, n: {} }] });
  });
});
