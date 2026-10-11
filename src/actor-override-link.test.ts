import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { BeadsClient } from "./beads.ts";
import { createFakeBd } from "./test-support/fake-bd.ts";
import { registerTools } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Out = { isError: boolean; body: any };

let harness: { client: Client; server: McpServer } | undefined;
afterEach(async () => {
  await harness?.client.close();
  await harness?.server.close();
  harness = undefined;
});

/**
 * Local copy of the harness in src/hardening.test.ts, trimmed to what this
 * file needs. Duplicated intentionally so this test can land independently
 * of sibling PRs touching the shared test-support/hardening files.
 */
async function setup(authenticatedActor?: string) {
  const fake = createFakeBd();
  const runSpy = vi.fn(fake.run);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, new BeadsClient(runSpy), authenticatedActor);
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

  function actorForCommand(name: string): string | undefined {
    const entry = runSpy.mock.calls.find(([args]) => args[0] === name);
    return entry?.[1] as string | undefined;
  }

  return { call, create, runSpy, actorForCommand };
}

describe("link actor override", () => {
  it("sends the verified JWT actor, not the spoofed args.actor, to dep add", async () => {
    const { call, create, actorForCommand } = await setup(
      "verified@example.com",
    );
    const a = await create({ actor: "spoofed@example.com" });
    const b = await create({ actor: "spoofed@example.com" });

    const added = await call("link", {
      id: a,
      target: b,
      actor: "spoofed@example.com",
      action: "add",
    });

    expect(added.isError).toBe(false);
    expect(actorForCommand("dep")).toBe("verified@example.com");
  });

  it("sends the verified JWT actor, not the spoofed args.actor, to dep remove", async () => {
    const { call, create, runSpy, actorForCommand } = await setup(
      "verified@example.com",
    );
    const a = await create({ actor: "spoofed@example.com" });
    const b = await create({ actor: "spoofed@example.com" });
    await call("link", {
      id: a,
      target: b,
      actor: "spoofed@example.com",
      action: "add",
    });
    runSpy.mockClear();

    const removed = await call("link", {
      id: a,
      target: b,
      actor: "spoofed@example.com",
      action: "remove",
    });

    expect(removed.isError).toBe(false);
    expect(actorForCommand("dep")).toBe("verified@example.com");
  });
});
