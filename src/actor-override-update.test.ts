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
  return { call, create };
}

describe("actor override: update", () => {
  it("sends the authenticated JWT actor to bd, never the spoofed args.actor", async () => {
    const fake = createFakeBd();
    const calls: Array<{ args: string[]; actor?: string }> = [];
    const spiedRun: BeadsCommand = (args, actor) => {
      calls.push({ args, actor });
      return fake.run(args, actor);
    };

    const { call, create } = await setup(spiedRun, "verified@example.com");
    const id = await create({ actor: "spoofed@example.com" });

    const result = await call("update", {
      id,
      actor: "spoofed@example.com",
      description: "new description",
    });
    expect(result.isError).toBe(false);

    const updateCall = calls.find(({ args }) => args[0] === "update");
    expect(updateCall?.actor).toBe("verified@example.com");
    expect(updateCall?.actor).not.toBe("spoofed@example.com");
    expect(fake.peek(id)?.description).toBe("new description");
  });

  it("cannot use a forged args.actor to borrow another actor's ownership", async () => {
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
    // though args.actor is forged to someone else: the status change succeeds.
    const ownerUpdate = await owner.call("update", {
      id,
      actor: "someone-else@example.com",
      status: "blocked",
    });
    expect(ownerUpdate.isError).toBe(false);
    expect(fake.peek(id)?.status).toBe("blocked");

    const snapshot = JSON.stringify(fake.peek(id));

    // The attacker forges args.actor as the real owner, but their verified
    // JWT actor is still "attacker@example.com", so the ownership check
    // uses that identity and rejects the change.
    const attackerUpdate = await attacker.call("update", {
      id,
      actor: "owner@example.com",
      status: "open",
    });
    expect(attackerUpdate.isError).toBe(true);
    expect(attackerUpdate.body).toMatchObject({
      code: "OWNERSHIP_CONFLICT",
      retryable: false,
      details: { id, assignee: "owner@example.com" },
    });
    expect(JSON.stringify(fake.peek(id))).toBe(snapshot);
  });
});
