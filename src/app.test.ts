import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createApp } from "./app.ts";

type AppHarness = {
  httpServer: HttpServer;
  handler: ReturnType<typeof createApp>["handler"];
  baseUrl: string;
  client?: Client;
};

let harness: AppHarness | undefined;

beforeEach(() => {
  vi.stubEnv("AUTH_JWT_HEADER", "X-Authenticated-JWT");
  vi.stubEnv("AUTH_JWKS_URL", "https://issuer.example.test/keys");
  vi.stubEnv("AUTH_ISSUER", "https://issuer.example.test/");
  vi.stubEnv("AUTH_AUDIENCE", "beads-mcp");
  vi.stubEnv("AUTH_ACTOR_CLAIM", "email");
});

afterEach(async () => {
  if (!harness) return;

  if (harness.client) {
    await harness.client.close();
  }
  await harness.handler.close();
  await closeHttpServer(harness.httpServer);
  harness = undefined;
  vi.unstubAllEnvs();
});

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function setupHttpServer() {
  const { app, handler } = createApp({
    jwtVerifier: async (token) => {
      if (token !== "valid-jwt") throw new Error("invalid token");
      return {
        actor: "alice@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        payload: { email: "alice@example.com" },
      };
    },
  });
  const httpServer = createServer(app);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected the HTTP server to have a TCP address");
  }

  harness = {
    httpServer,
    handler,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
  return harness;
}

async function setupHttpClient() {
  const appHarness = await setupHttpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" }, {});
  const transport = new StreamableHTTPClientTransport(
    new URL(`${appHarness.baseUrl}/mcp`),
    { requestInit: { headers: { "X-Authenticated-JWT": "valid-jwt" } } },
  );

  await client.connect(transport);
  appHarness.client = client;
  return { ...appHarness, client };
}

describe("HTTP app", () => {
  it("serves the health endpoint through Express", async () => {
    const { baseUrl } = await setupHttpServer();

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves MCP requests through Express and the Node adapter", async () => {
    const { client } = await setupHttpClient();

    const result = await client.listTools();
    expect(result.tools.some((tool) => tool.name === "ready")).toBe(true);
  });

  it("requires a valid identity JWT while leaving liveness public", async () => {
    const { baseUrl } = await setupHttpServer();
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "X-Authenticated-JWT": "invalid-jwt" },
        })
      ).status,
    ).toBe(401);
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "X-Authenticated-JWT": "valid-jwt",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
  });

  it("returns a client error for malformed JSON", async () => {
    const { baseUrl } = await setupHttpServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "X-Authenticated-JWT": "valid-jwt",
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
  });
});
