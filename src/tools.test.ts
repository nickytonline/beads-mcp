import { afterEach, describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.ts";
import { BeadsClient, type BeadsCommand } from "./beads.ts";

let harness: { client: Client; server: McpServer } | undefined;
afterEach(async () => {
  await harness?.client.close();
  await harness?.server.close();
});
async function setup(run: BeadsCommand = async () => []) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, new BeadsClient(run).transaction);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  harness = { client, server };
  return client;
}

describe("Beads MCP tools", () => {
  it("advertises eleven tools with input/output schemas and no arbitrary command tool", async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "ready",
        "search",
        "get",
        "create",
        "update",
        "claim",
        "release",
        "add_note",
        "link",
        "complete",
        "handoff",
      ].sort(),
    );
    expect(tools.every((tool) => tool.inputSchema && tool.outputSchema)).toBe(
      true,
    );
  });
  it("advertises input constraints that match validation", async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    const update = tools.find((tool) => tool.name === "update");
    const properties = update?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.id).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
    });
    expect(properties.expected_revision).toMatchObject({
      pattern: "^s1-[0-9a-f]{16}$",
    });
    // Optional fields are omitted, never null; advertising null would invite
    // calls that validation then rejects.
    expect(properties.priority).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 4,
      description: "Priority: 0 highest, 4 lowest",
    });
    expect(update?.inputSchema.required).toEqual(["id"]);
  });
  it("passes user text as a single flag value without shell interpolation", async () => {
    const run = vi.fn<BeadsCommand>().mockResolvedValue({ id: "task-1" });
    const client = await setup(run);
    const title = "--help $(touch /tmp/nope) `id`";
    const result = await client.callTool({
      name: "create",
      arguments: { title, actor: "agent-1", priority: 0 },
    });
    expect(run).toHaveBeenCalledWith(
      ["create", `--title=${title}`, "--priority=0"],
      "agent-1",
    );
    expect(result.structuredContent).toEqual({ data: { id: "task-1" } });
  });
  it("rejects flag-shaped issue IDs before executing commands", async () => {
    const run = vi.fn<BeadsCommand>();
    const client = await setup(run);
    const result = await client.callTool({
      name: "get",
      arguments: { id: "--help" },
    });
    expect(result.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("blocks releases by a different agent", async () => {
    const run = vi
      .fn<BeadsCommand>()
      .mockResolvedValue([{ id: "task-1", assignee: "other" }]);
    const client = await setup(run);
    const result = await client.callTool({
      name: "release",
      arguments: { id: "task-1", actor: "agent-1" },
    });
    expect(result.isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("records handoff before releasing and reports a partial release failure", async () => {
    const run = vi
      .fn<BeadsCommand>()
      .mockResolvedValueOnce([{ assignee: "agent-1" }])
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(new Error("failed"));
    const client = await setup(run);
    const result = await client.callTool({
      name: "handoff",
      arguments: {
        id: "task-1",
        actor: "agent-1",
        done: "a",
        remaining: "b",
        next: "c",
        release: true,
      },
    });
    expect(result.structuredContent).toMatchObject({
      data: { released: false, note: { id: 1 } },
    });
    expect(run.mock.calls[1][0].slice(0, 4)).toEqual([
      "comments",
      "add",
      "task-1",
      "--",
    ]);
  });
  it("returns execution errors in-band and handles the next request", async () => {
    const run = vi
      .fn<BeadsCommand>()
      .mockRejectedValueOnce(new Error("claim conflict"))
      .mockResolvedValueOnce([]);
    const client = await setup(run);
    expect(
      (
        await client.callTool({
          name: "claim",
          arguments: { id: "task-1", actor: "agent-1" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: "ready", arguments: {} }))
        .structuredContent,
    ).toEqual({ data: [] });
  });
});
