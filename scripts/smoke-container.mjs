import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const suffix = randomBytes(6).toString("hex");
const name = `beads-smoke-${suffix}`;
const volume = `${name}-data`;
const image = process.argv[2] ?? "beads-mcp:0.1.0";
const actor = "smoke@example.com";
const issuer = "https://issuer.example.test/";
const audience = "beads-mcp";
const jwksPath = "/.well-known/jwks.json";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
jwk.kid = "smoke-key";
jwk.alg = "RS256";
jwk.use = "sig";
const jwks = { keys: [jwk] };
const jwt = await new SignJWT({ email: actor })
  .setProtectedHeader({ alg: "RS256", kid: "smoke-key", typ: "JWT" })
  .setIssuer(issuer)
  .setAudience(audience)
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(privateKey);

const jwksServer = createServer((request, response) => {
  if (request.url !== jwksPath) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(jwks));
});

const docker = (...args) => {
  try {
    return execFileSync(
      "docker",
      ["--host=unix:///var/run/docker.sock", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error(`Docker ${args[0]} failed`);
  }
};

let client;
let baseUrl;

async function start(jwksPort) {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
    "--tmpfs",
    "/tmp:uid=1000,gid=1000",
    "--tmpfs",
    "/home/node:uid=1000,gid=1000",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${volume}:/data`,
    "-e",
    `AUTH_JWKS_URL=http://host.docker.internal:${jwksPort}${jwksPath}`,
    "-e",
    `AUTH_ISSUER=${issuer}`,
    "-e",
    `AUTH_AUDIENCE=${audience}`,
    "-e",
    "DOLT_ROOT_PATH=/data/dolt-config",
    "-p",
    "127.0.0.1::3000",
    image,
  );
  const address = docker("port", name, "3000/tcp");
  baseUrl = `http://${address}`;
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!healthy) throw new Error("Container did not become healthy");
  if (docker("exec", name, "id", "-u") !== "1000")
    throw new Error("Container is not running as the node user");
  docker(
    "exec",
    name,
    "sh",
    "-c",
    "touch /home/node/.smoke-home /tmp/.smoke-tmp",
  );
  if ((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status !== 401)
    throw new Error("Missing identity JWT was not rejected");
  if (
    (
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "X-Authenticated-JWT": "invalid" },
      })
    ).status !== 401
  )
    throw new Error("Invalid identity JWT was not rejected");

  client = new Client({ name: "container-smoke", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { "X-Authenticated-JWT": jwt } },
    }),
  );
  const tools = await client.listTools();
  const expectedTools = [
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
  ];
  if (
    tools.tools.length !== expectedTools.length ||
    !expectedTools.every((tool) => tools.tools.some(({ name }) => name === tool))
  )
    throw new Error("Expected all eleven tools");
}

async function stop() {
  await client?.close();
  client = undefined;
  docker("stop", "-t", "40", name);
  docker("rm", name);
}

const addressPromise = new Promise((resolve, reject) => {
  jwksServer.once("error", reject);
  jwksServer.listen(0, "0.0.0.0", () => {
    const address = jwksServer.address();
    if (!address || typeof address === "string") {
      reject(new Error("JWKS server did not get a TCP address"));
      return;
    }
    resolve(address.port);
  });
});

try {
  const jwksPort = await addressPromise;
  docker("volume", "create", volume);
  await start(jwksPort);
  const created = await client.callTool({
    name: "create",
    arguments: {
      title: "Container persistence smoke test",
      actor: "spoofed@example.com",
    },
  });
  if (created.isError) throw new Error("Create failed");
  const id = created.structuredContent.data.id;
  await client.callTool({
    name: "add_note",
    arguments: {
      id,
      actor: "spoofed@example.com",
      note: "JWT actor smoke test",
    },
  });
  const beforeReplacement = await client.callTool({
    name: "get",
    arguments: { id },
  });
  const beforeJson = JSON.stringify(beforeReplacement.structuredContent);
  if (!beforeJson.includes(actor) || beforeJson.includes("spoofed@example.com"))
    throw new Error("Beads did not record the verified JWT actor");

  await stop();
  await start(jwksPort);
  const restored = await client.callTool({ name: "get", arguments: { id } });
  if (
    restored.isError ||
    !JSON.stringify(restored.structuredContent).includes(id)
  )
    throw new Error("Task did not survive container replacement");
  process.stdout.write(
    "Container smoke passed: JWT authentication, health, eleven tools, actor attribution, read-only filesystem, and persistence across replacement.\n",
  );
} finally {
  await client?.close();
  try {
    docker("stop", "-t", "40", name);
  } catch {}
  try {
    docker("rm", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
  await new Promise((resolve) => jwksServer.close(resolve));
}
