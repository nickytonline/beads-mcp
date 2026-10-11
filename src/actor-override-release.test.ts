import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { BeadsClient, type BeadsCommand } from "./beads.ts";
import { createFakeBd } from "./test-support/fake-bd.ts";
import { registerTools } from "./tools.ts";

/*
 * This file deliberately does not import from or modify src/hardening.test.ts
 * or src/test-support/fake-bd.ts: it duplicates the small amount of harness
 * setup it needs so it can land independently of sibling PRs covering the
 * same actor-override guarantee for update/complete/handoff/link.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Out = { isError: boolean; body: any };

const harnesses: { client: Client; server: McpServer }[] = [];
afterEach(async () => {
  await Promise.all(
    harnesses.map((harness) =>
      Promise.all([harness.client.close(), harness.server.close()]),
    ),
  );
  harnesses.length = 0;
});

async function setup(run: BeadsCommand, authenticatedActor?: string) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, new BeadsClient(run), authenticatedActor);
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

/** Wraps a BeadsCommand to record every (args, actor) pair it is called with. */
function spyOn(run: BeadsCommand) {
  const calls: { args: string[]; actor?: string }[] = [];
  const spied: BeadsCommand = (args, actor) => {
    calls.push({ args, actor });
    return run(args, actor);
  };
  return { run: spied, calls };
}

describe("release: verified actor overrides spoofed args.actor", () => {
  it("sends the authenticated actor, never the spoofed actor, to every bd call release makes", async () => {
    const fake = createFakeBd();
    const { run, calls } = spyOn(fake.run);
    const { call, create } = await setup(run, "verified@example.com");

    const id = await create({ actor: "spoofed@example.com" });
    await call("claim", { id, actor: "spoofed@example.com" });
    expect(fake.peek(id)?.assignee).toBe("verified@example.com");

    calls.length = 0; // only inspect the calls made by the release below
    const released = await call("release", {
      id,
      actor: "spoofed@example.com",
      reason: "handing off",
    });

    expect(released.isError).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    for (const recorded of calls) {
      expect(recorded.actor).toBe("verified@example.com");
      expect(recorded.actor).not.toBe("spoofed@example.com");
    }
    // Both the reason comment and the assignee-clearing update happened.
    expect(calls.some((c) => c.args[0] === "comments")).toBe(true);
    expect(
      calls.some(
        (c) => c.args[0] === "update" && c.args.includes("--assignee="),
      ),
    ).toBe(true);
    expect(fake.peek(id)?.assignee).toBeUndefined();
    expect(fake.peek(id)?.status).toBe("open");
  });

  it("cannot be used to borrow another actor's identity to bypass ownership", async () => {
    const fake = createFakeBd();

    const owner = await setup(fake.run, "owner@example.com");
    const attacker = await setup(fake.run, "attacker@example.com");

    const id = await owner.create({ actor: "owner@example.com" });
    await owner.call("claim", { id, actor: "owner@example.com" });
    expect(fake.peek(id)?.assignee).toBe("owner@example.com");

    // The real owner releasing is unaffected by a forged args.actor.
    const ownRelease = await owner.call("release", {
      id,
      actor: "nobody@example.com",
    });
    expect(ownRelease.isError).toBe(false);
    expect(fake.peek(id)?.assignee).toBeUndefined();
    expect(fake.peek(id)?.status).toBe("open");

    // Re-claim as the owner, then an attacker forges args.actor as the owner.
    await owner.call("claim", { id, actor: "owner@example.com" });
    expect(fake.peek(id)?.assignee).toBe("owner@example.com");

    const stolen = await attacker.call("release", {
      id,
      actor: "owner@example.com",
    });
    expect(stolen.isError).toBe(true);
    expect(stolen.body).toMatchObject({
      code: "OWNERSHIP_CONFLICT",
      retryable: false,
      details: { id, assignee: "owner@example.com" },
    });
    expect(fake.peek(id)?.assignee).toBe("owner@example.com");
    expect(fake.peek(id)?.status).toBe("in_progress");
  });
});
