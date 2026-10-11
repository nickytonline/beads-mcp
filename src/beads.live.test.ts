import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.ts";
import { BeadsClient } from "./beads.ts";

it.runIf(process.env.BEADS_LIVE_TEST === "1")(
  "runs the agent work loop against real embedded Beads over HTTP transport",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "beads-mcp-"));
    vi.stubEnv("BEADS_PROJECT_DIR", directory);
    vi.stubEnv("BEADS_DIR", join(directory, ".beads"));
    vi.stubEnv("DOLT_ROOT_PATH", join(directory, "dolt-config"));
    const queue = new BeadsClient();
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "beads-test", version: "0.0.0" });
      registerTools(server, queue);
      return server;
    });
    const client = new Client({ name: "live-test", version: "0.0.0" });
    try {
      execFileSync(
        process.env.BD_BIN ?? "bd",
        [
          "init",
          "--prefix=task",
          "--skip-agents",
          "--skip-hooks",
          "--non-interactive",
        ],
        { cwd: directory, env: process.env, stdio: "pipe" },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
          fetch: async (input, init) => handler.fetch(new Request(input, init)),
        }),
      );
      async function call(name: string, args: Record<string, unknown>) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, JSON.stringify(result)).toBeFalsy();
        return (result.structuredContent as Record<string, unknown> | undefined)
          ?.data;
      }
      const created = await call("create", {
        actor: "a",
        title: "Prerequisite",
        description: "Test",
        acceptance: "Verified",
        priority: 1,
      });
      const id = (created as { id: string }).id;
      expect(id).toMatch(/^task-/);
      const child = await call("create", {
        actor: "a",
        title: "Followup",
        deps: id,
      });
      const childId = (child as { id: string }).id;
      const ready = await call("ready", {});
      expect((ready as { id: string }[]).map((t) => t.id)).toContain(id);
      expect((ready as { id: string }[]).map((t) => t.id)).not.toContain(
        childId,
      );
      await call("search", { query: "Prerequisite" });
      await call("update", {
        id,
        actor: "a",
        title: "Updated prerequisite",
        "add-label": "test",
      });
      const claims = await Promise.all(
        ["a", "b"].map((actor) =>
          client.callTool({ name: "claim", arguments: { id, actor } }),
        ),
      );
      expect(claims.filter((result) => !result.isError)).toHaveLength(1);
      await call("get", { id });
      await call("add_note", {
        id,
        actor: "a",
        note: "--literal $(not-a-command)",
      });
      await call("handoff", {
        id,
        actor: "a",
        done: "Found issue",
        remaining: "Fix it",
        next: "Patch",
        release: true,
      });
      await call("claim", { id, actor: "b" });
      await call("release", { id, actor: "b", reason: "Available again" });
      await call("link", {
        id: childId,
        target: id,
        actor: "a",
        action: "remove",
      });
      await call("link", {
        id: childId,
        target: id,
        actor: "a",
        action: "add",
        type: "blocks",
      });
      await call("complete", {
        id,
        actor: "a",
        summary: "Verified by integration test",
      });
      const next = await call("ready", {});
      expect((next as { id: string }[]).map((t) => t.id)).toContain(childId);
    } finally {
      await client.close();
      await handler.close();
      await queue.drain();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
