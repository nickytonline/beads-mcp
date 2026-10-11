import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { BeadsClient } from "./beads.ts";
import { createFakeBd } from "./test-support/fake-bd.ts";
import { registerTools } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Out = { isError: boolean; body: any };

let harnesses: { client: Client; server: McpServer }[] = [];
afterEach(async () => {
  await Promise.all(
    harnesses.map(async (h) => {
      await h.client.close();
      await h.server.close();
    }),
  );
  harnesses = [];
});

/**
 * Wires an in-memory MCP client/server pair over the given fake `bd`
 * backend, mirroring the `setup()` helper in src/hardening.test.ts. Kept
 * local so this file has zero shared-file edits.
 */
async function setup(
  fake: ReturnType<typeof createFakeBd>,
  authenticatedActor?: string,
) {
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
  return { call, create };
}

describe("complete: JWT actor overrides spoofed actor", () => {
  it("sends the verified actor to bd's close command, never the spoofed args.actor", async () => {
    const fake = createFakeBd();
    const calls: { args: string[]; actor?: string }[] = [];
    const spiedRun = vi.fn((args: string[], actor?: string) => {
      calls.push({ args, actor });
      return fake.run(args, actor);
    });

    const { call, create } = await setup(
      { ...fake, run: spiedRun },
      "verified@example.com",
    );
    const id = await create({ actor: "spoofed@example.com" });
    await call("claim", { id, actor: "spoofed@example.com" });

    const result = await call("complete", {
      id,
      actor: "spoofed@example.com",
      summary: "done",
    });
    expect(result.isError).toBe(false);

    const closeCall = calls.find((c) => c.args[0] === "close");
    expect(closeCall?.actor).toBe("verified@example.com");
    expect(closeCall?.actor).not.toBe("spoofed@example.com");
  });

  it("cannot use a forged args.actor to borrow another actor's ownership", async () => {
    const fake = createFakeBd();

    // Real owner completes their own claimed task despite a forged actor.
    const owner = await setup(fake, "owner@example.com");
    const ownedId = await owner.create();
    await owner.call("claim", { id: ownedId, actor: "owner@example.com" });
    const ownerComplete = await owner.call("complete", {
      id: ownedId,
      actor: "someone-else@example.com",
      summary: "done",
    });
    expect(ownerComplete.isError).toBe(false);
    expect(fake.peek(ownedId)?.status).toBe("closed");

    // A fresh task, claimed by the real owner the same way as above. An
    // attacker, authenticated as a different identity, tries to complete it
    // by forging args.actor to the real owner's identity. The attacker's own
    // authenticated identity still governs the ownership check, so forging
    // args.actor cannot borrow the owner's claim.
    const contestedId = await owner.create();
    await owner.call("claim", { id: contestedId, actor: "owner@example.com" });

    const attacker = await setup(fake, "attacker@example.com");
    const forged = await attacker.call("complete", {
      id: contestedId,
      actor: "owner@example.com",
      summary: "stolen",
    });
    expect(forged.isError).toBe(true);
    expect(forged.body).toMatchObject({
      code: "OWNERSHIP_CONFLICT",
      retryable: false,
      details: { id: contestedId, assignee: "owner@example.com" },
    });
    expect(fake.peek(contestedId)).toMatchObject({
      status: "in_progress",
      assignee: "owner@example.com",
    });
  });
});
