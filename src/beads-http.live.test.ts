/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.ts";
import { BeadsClient } from "./beads.ts";
import { makeExecuteBeadsHttp } from "./beads-http.ts";

/**
 * Runs the same agent work loop as `beads.live.test.ts`, but through
 * `bd serve` over HTTP (the --server, non-experimental Dolt mode) instead of
 * per-call CLI exec. Opt-in and gated behind `BD_SERVE_LIVE_TEST=1` because it
 * needs a real `dolt` binary on PATH and two free ports; see README "Running
 * in HTTP execution mode".
 */

function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await check().catch(() => false)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    void tick();
  });
}

it.runIf(process.env.BD_SERVE_LIVE_TEST === "1")(
  "runs the agent work loop against real bd serve (--server Dolt mode) over HTTP",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "beads-mcp-http-"));
    const doltPort = 20_000 + (process.pid % 10_000);
    const servePort = 30_000 + (process.pid % 10_000);
    const bdBin = process.env.BD_BIN ?? "bd";
    let doltServer: ChildProcess | undefined;
    let bdServe: ChildProcess | undefined;
    let client: Client | undefined;
    let queue: BeadsClient | undefined;

    try {
      execFileSync("git", ["init", "-q"], { cwd: directory });
      execFileSync(
        "git",
        [
          "-c",
          "user.email=t@t.com",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "-m",
          "init",
          "--allow-empty",
        ],
        { cwd: directory },
      );
      execFileSync(
        "dolt",
        ["init", "--name", "test", "--email", "test@example.com"],
        { cwd: directory, stdio: "ignore" },
      );

      doltServer = spawn(
        "dolt",
        ["sql-server", "--host", "127.0.0.1", "--port", String(doltPort)],
        { cwd: directory, stdio: "ignore" },
      );
      await waitFor(async () => {
        try {
          execFileSync(
            "dolt",
            [
              "--no-tls",
              "--host",
              "127.0.0.1",
              "--port",
              String(doltPort),
              "--user",
              "root",
              "--password",
              "",
              "sql",
              "-q",
              "select 1",
            ],
            {
              cwd: directory,
              stdio: "ignore",
            },
          );
          return true;
        } catch {
          return false;
        }
      }, 15_000);

      execFileSync(
        bdBin,
        [
          "init",
          "--non-interactive",
          "--server",
          "--server-host=127.0.0.1",
          `--server-port=${doltPort}`,
          "--server-user=root",
          "--prefix=task",
          "--skip-agents",
          "--skip-hooks",
        ],
        { cwd: directory, env: process.env, stdio: "pipe" },
      );

      bdServe = spawn(bdBin, ["serve", `--addr=127.0.0.1:${servePort}`], {
        cwd: directory,
        stdio: "ignore",
      });
      const baseUrl = `http://127.0.0.1:${servePort}`;
      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/v0/beads/context`);
        return response.ok;
      }, 15_000);

      queue = new BeadsClient(makeExecuteBeadsHttp(baseUrl));
      const server = new McpServer({
        name: "beads-http-test",
        version: "0.0.0",
      });
      registerTools(server, queue.transaction);
      client = new Client({ name: "live-http-test", version: "0.0.0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientSide),
        server.connect(serverSide),
      ]);

      async function call(name: string, args: Record<string, unknown>) {
        const result: any = await client!.callTool({ name, arguments: args });
        if (result.isError) throw new Error(JSON.stringify(result));
        return result.structuredContent?.data;
      }

      const created = await call("create", {
        actor: "a",
        title: "Prerequisite",
        description: "Test",
        acceptance: "Verified",
        priority: 1,
      });
      const id = created.id;
      const child = await call("create", {
        actor: "a",
        title: "Followup",
        deps: id,
      });
      const childId = child.id;

      const ready = await call("ready", {});
      const readyIds = ready.map((task: any) => task.id);
      if (!readyIds.includes(id) || readyIds.includes(childId)) {
        throw new Error(`unexpected ready set: ${JSON.stringify(readyIds)}`);
      }

      await call("search", { query: "Prerequisite" });
      await call("update", {
        id,
        actor: "a",
        title: "Updated prerequisite",
        "add-label": "test",
      });

      const claims = await Promise.allSettled(
        ["a", "b"].map((actor) => call("claim", { id, actor })),
      );
      if (
        claims.filter((result) => result.status === "fulfilled").length !== 1
      ) {
        throw new Error("expected exactly one successful claim");
      }

      await call("get", { id });
      await call("add_note", { id, actor: "a", note: "a finding" });
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
      if (!next.map((task: any) => task.id).includes(childId)) {
        throw new Error(
          "expected child to become ready after parent completed",
        );
      }
    } finally {
      await client?.close();
      await queue?.drain();
      bdServe?.kill();
      doltServer?.kill();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
