import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { BeadsClient, type BeadsCommand } from "./beads.ts";
import { createFakeBd } from "./test-support/fake-bd.ts";
import { registerTools } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Out = { isError: boolean; body: any };

const harnesses: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  await Promise.all(
    harnesses.map(async (h) => {
      await h.client.close();
      await h.server.close();
    }),
  );
  harnesses.length = 0;
});

/** Wires an in-memory MCP client/server pair over `run`, authenticated as `authenticatedActor`. */
async function setup(run: BeadsCommand, authenticatedActor?: string) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, new BeadsClient(run).transaction, authenticatedActor);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  harnesses.push({ client, server });

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
  return { call, create, get };
}

describe("actor override: handoff", () => {
  it("records the authenticated JWT actor, never the spoofed args.actor, as both the comment author and the embedded handoff actor", async () => {
    const fake = createFakeBd();
    const { call, create, get } = await setup(fake.run, "verified@example.com");
    const id = await create({ actor: "spoofed@example.com" });
    await call("claim", { id, actor: "spoofed@example.com" });

    const handoff = await call("handoff", {
      id,
      actor: "spoofed@example.com",
      done: "wrote the migration",
      remaining: "review and rollout",
      next: "open the PR",
      release: true,
    });
    expect(handoff.isError).toBe(false);

    const task = await get(id);
    const comment = task.comments?.[0];
    expect(comment?.author).toBe("verified@example.com");
    expect(comment?.author).not.toBe("spoofed@example.com");

    const body = JSON.parse(comment?.text ?? "{}");
    expect(body).toMatchObject({
      kind: "handoff",
      actor: "verified@example.com",
      done: "wrote the migration",
      remaining: "review and rollout",
      next: "open the PR",
    });
    expect(body.actor).not.toBe("spoofed@example.com");

    // release: true cleared the claim under the authenticated actor too.
    expect(task.assignee).toBeUndefined();
    expect(task.status).toBe("open");
  });

  it("cannot use a forged args.actor to borrow the real owner's identity for handoff", async () => {
    const fake = createFakeBd();
    const owner = await setup(fake.run, "owner@example.com");
    const attacker = await setup(fake.run, "attacker@example.com");

    const id = await owner.create();
    const claimed = await owner.call("claim", {
      id,
      actor: "owner@example.com",
    });
    expect(claimed.isError).toBe(false);
    expect(fake.peek(id)?.assignee).toBe("owner@example.com");

    // The real owner's authenticated actor still matches the assignee, even
    // though args.actor is forged to someone else: the handoff succeeds.
    const ownerHandoff = await owner.call("handoff", {
      id,
      actor: "someone-else@example.com",
      done: "d",
      remaining: "r",
      next: "n",
    });
    expect(ownerHandoff.isError).toBe(false);
    expect(fake.peek(id)?.comment_count).toBe(1);

    // Fresh task, claimed the same way by the real owner.
    const freshId = await owner.create();
    const freshClaimed = await owner.call("claim", {
      id: freshId,
      actor: "owner@example.com",
    });
    expect(freshClaimed.isError).toBe(false);
    const before = fake.peek(freshId)?.comment_count;

    // The attacker forges args.actor as the real owner, but their verified
    // JWT actor is still "attacker@example.com", so the ownership check uses
    // that identity and rejects the handoff without recording a note.
    const attackerHandoff = await attacker.call("handoff", {
      id: freshId,
      actor: "owner@example.com",
      done: "d",
      remaining: "r",
      next: "n",
    });
    expect(attackerHandoff.isError).toBe(true);
    expect(attackerHandoff.body).toMatchObject({
      code: "OWNERSHIP_CONFLICT",
      retryable: false,
      details: { id: freshId, assignee: "owner@example.com" },
    });
    expect(fake.peek(freshId)?.comment_count).toBe(before);
  });
});
