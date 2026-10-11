import { createServer, type Server as HttpServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let createApp: typeof import("./app.ts").createApp;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let jwksServer: HttpServer;
let httpServer: HttpServer;
let handler: ReturnType<typeof createApp>["handler"];
let baseUrl: string;
let privateKey: SigningKey;
let otherPrivateKey: SigningKey;
let jwk: JWK;
let jwksRequests: number;
let jwksResponse: {
  status: number;
  body: unknown;
  disconnect?: boolean;
  hang?: boolean;
};

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: HttpServer) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function token(
  claims: Record<string, unknown> = { email: "alice@example.com" },
  header = { alg: "ES256", kid: "test-key" },
) {
  return new SignJWT(claims)
    .setProtectedHeader(header)
    .setIssuer("https://issuer.example.test/")
    .setAudience("beads-mcp")
    .setExpirationTime("5m");
}

async function request(jwt?: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(jwt === undefined ? {} : { "X-Authenticated-JWT": jwt }),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

beforeAll(async () => {
  const keys = await generateKeyPair("ES256");
  privateKey = keys.privateKey;
  otherPrivateKey = (await generateKeyPair("ES256")).privateKey;
  jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key" };
  jwksServer = createServer((req, res) => {
    jwksRequests++;
    if (jwksResponse.disconnect) {
      req.socket.destroy();
      return;
    }
    if (jwksResponse.hang) return;
    res.writeHead(jwksResponse.status, { "content-type": "application/json" });
    res.end(
      typeof jwksResponse.body === "string"
        ? jwksResponse.body
        : JSON.stringify(jwksResponse.body),
    );
  });
  const jwksUrl = await listen(jwksServer);
  vi.stubEnv("AUTH_JWT_HEADER", "X-Authenticated-JWT");
  vi.stubEnv("AUTH_JWKS_URL", `${jwksUrl}/keys`);
  vi.stubEnv("AUTH_ISSUER", "https://issuer.example.test/");
  vi.stubEnv("AUTH_AUDIENCE", "beads-mcp");
  vi.stubEnv("AUTH_ACTOR_CLAIM", "email");
  ({ createApp } = await import("./app.ts"));
});

beforeEach(async () => {
  jwksRequests = 0;
  jwksResponse = { status: 200, body: { keys: [jwk] } };
  const app = createApp();
  handler = app.handler;
  httpServer = createServer(app.app);
  baseUrl = await listen(httpServer);
});

afterEach(async () => {
  await handler?.close();
  if (httpServer?.listening) await close(httpServer);
});

afterAll(async () => {
  if (jwksServer?.listening) await close(jwksServer);
  vi.unstubAllEnvs();
});

describe("HTTP JWT authentication with remote JWKS", () => {
  it("accepts a signed JWT and reuses cached JWKS keys", async () => {
    const jwt = await token().sign(privateKey);
    expect((await request(jwt)).status).toBe(200);
    expect((await request(jwt)).status).toBe(200);
    expect(jwksRequests).toBe(1);
  });

  it.each([
    ["missing", async () => undefined],
    ["malformed", async () => "not-a-jwt"],
    ["expired", async () => token().setExpirationTime(0).sign(privateKey)],
    [
      "wrong audience",
      async () => token().setAudience("other").sign(privateKey),
    ],
    ["wrong issuer", async () => token().setIssuer("other").sign(privateKey)],
    ["bad signature", async () => token().sign(otherPrivateKey)],
    ["missing actor", async () => token({}).sign(privateKey)],
    [
      "unknown signing key",
      async () =>
        token(undefined, { alg: "ES256", kid: "unknown-key" }).sign(privateKey),
    ],
    [
      "unsupported algorithm",
      async () =>
        token(undefined, { alg: "HS256", kid: "test-key" }).sign(
          new Uint8Array(32),
        ),
    ],
  ])("returns 401 for %s tokens", async (_kind, jwt) => {
    const response = await request(await jwt());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the token matches multiple signing keys", async () => {
    jwksResponse.body = { keys: [jwk, jwk] };
    const response = await request(await token().sign(privateKey));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects malformed tokens without contacting an unavailable JWKS provider", async () => {
    jwksResponse.status = 500;
    const response = await request("not-a-jwt");
    expect(response.status).toBe(401);
    expect(jwksRequests).toBe(0);
  });

  it.each([
    ["HTTP failure", { status: 500, body: { error: "provider detail" } }],
    ["invalid JSON", { status: 200, body: "provider detail" }],
    ["malformed JWKS", { status: 200, body: { keys: "provider detail" } }],
    [
      "unusable key",
      {
        status: 200,
        body: { keys: [{ kty: "EC", crv: "P-256", kid: "test-key" }] },
      },
    ],
    ["connection failure", { status: 200, body: {}, disconnect: true }],
    ["timeout", { status: 200, body: {}, hang: true }],
  ])(
    "returns 503 for a JWKS %s",
    async (_kind, failure) => {
      jwksResponse = failure;
      const jwt = await token().sign(privateKey);
      const response = await request(jwt);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Authentication service unavailable",
      });
      expect(jwksRequests).toBe(1);
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    },
    10_000,
  );

  it("logs the provider failure without exposing details or the JWT in the response", async () => {
    jwksResponse.body = "provider detail";
    const jwt = await token().sign(privateKey);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await request(jwt);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Authentication service unavailable",
      });
      const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(entries).toContainEqual(
        expect.objectContaining({
          message: "JWT verification failed for /mcp request",
          logLevel: "WARN",
          annotations: expect.objectContaining({
            error: "Failed to parse the JSON Web Key Set HTTP response as JSON",
          }),
        }),
      );
      expect(JSON.stringify(entries)).not.toContain(jwt);
      expect(JSON.stringify(entries)).not.toContain("provider detail");
    } finally {
      log.mockRestore();
    }
  });

  it("recovers after a JWKS outage without restarting the app", async () => {
    jwksResponse.status = 503;
    const jwt = await token().sign(privateKey);
    expect((await request(jwt)).status).toBe(503);
    jwksResponse.status = 200;
    expect((await request(jwt)).status).toBe(200);
    expect(jwksRequests).toBe(2);
  });
});
