import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const suffix = randomBytes(6).toString("hex");
const name = `beads-smoke-${suffix}`;
const volume = `${name}-data`;
const token = randomBytes(32).toString("hex");
const image = process.argv[2] ?? "beads-mcp:0.1.0";
const docker = (...args) => {
  try { return execFileSync("docker", ["--host=unix:///var/run/docker.sock", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`Docker ${args[0]} failed`); }
};
let client;
async function start() {
  docker("run", "-d", "--name", name, "--read-only", "--tmpfs", "/tmp:uid=1000,gid=1000", "--tmpfs", "/home/node:uid=1000,gid=1000", "-v", `${volume}:/data`, "-e", `MCP_TOKEN=${token}`, "-e", "DOLT_ROOT_PATH=/data/dolt-config", "-p", "127.0.0.1::3000", image);
  const address = docker("port", name, "3000/tcp");
  const url = `http://${address}`;
  let healthy = false;
  for (let attempt=0; attempt<60; attempt++) {
    try { if ((await fetch(`${url}/health`)).ok) { healthy=true; break; } } catch {}
    await new Promise((resolve)=>setTimeout(resolve,500));
  }
  if (!healthy) throw new Error("Container did not become healthy");
  if ((await fetch(`${url}/mcp`, { method: "POST" })).status !== 401) throw new Error("Missing token was not rejected");
  client = new Client({ name: "container-smoke", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  if ((await client.listTools()).tools.length !== 11) throw new Error("Expected eleven tools");
}
async function stop() {
  await client?.close(); client = undefined;
  docker("stop", "-t", "40", name);
  docker("rm", name);
}
try {
  docker("volume", "create", volume);
  await start();
  const created = await client.callTool({ name: "create", arguments: { title: "Container persistence smoke test", actor: "smoke" } });
  if (created.isError) throw new Error("Create failed");
  const id = created.structuredContent.data.id;
  await stop();
  await start();
  const restored = await client.callTool({ name: "get", arguments: { id } });
  if (restored.isError || !JSON.stringify(restored.structuredContent).includes(id)) throw new Error("Task did not survive container replacement");
  process.stdout.write("Container smoke passed: initialization, authenticated MCP, eleven tools, read-only filesystem, and persistence across replacement.\n");
} finally {
  await client?.close();
  try { docker("stop", "-t", "40", name); } catch {}
  try { docker("rm", name); } catch {}
  try { docker("volume", "rm", volume); } catch {}
}
