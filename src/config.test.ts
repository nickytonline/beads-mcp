import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../package.json", () => ({
  default: {
    name: "from-package-json",
    version: "9.9.9",
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function importConfig() {
  vi.resetModules();
  return import("./config.ts");
}

describe("configuration", () => {
  it("defaults the server name and version from package.json", async () => {
    vi.stubEnv("PORT", undefined);
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("SERVER_NAME", undefined);
    vi.stubEnv("SERVER_VERSION", undefined);
    vi.stubEnv("LOG_LEVEL", undefined);
    vi.stubEnv("AUTH_JWT_HEADER", undefined);
    vi.stubEnv(
      "AUTH_JWKS_URL",
      "https://issuer.example.test/.well-known/jwks.json",
    );
    vi.stubEnv("AUTH_ISSUER", "https://issuer.example.test/");
    vi.stubEnv("AUTH_AUDIENCE", "beads-mcp");
    vi.stubEnv("AUTH_ACTOR_CLAIM", undefined);

    const { getConfig } = await importConfig();

    expect(getConfig()).toEqual({
      PORT: 3000,
      NODE_ENV: "development",
      SERVER_NAME: "from-package-json",
      SERVER_VERSION: "9.9.9",
      LOG_LEVEL: "info",
      AUTH_JWT_HEADER: "X-Authenticated-JWT",
      AUTH_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
      AUTH_ISSUER: "https://issuer.example.test/",
      AUTH_AUDIENCE: "beads-mcp",
      AUTH_ACTOR_CLAIM: "email",
    });
  });

  it("loads and parses environment values", async () => {
    vi.stubEnv("PORT", "4311");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SERVER_NAME", "custom-server");
    vi.stubEnv("SERVER_VERSION", "2.0.0");
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.stubEnv("AUTH_JWT_HEADER", "X-Identity");
    vi.stubEnv("AUTH_JWKS_URL", "https://issuer.example.test/keys");
    vi.stubEnv("AUTH_ISSUER", "issuer");
    vi.stubEnv("AUTH_AUDIENCE", "audience");
    vi.stubEnv("AUTH_ACTOR_CLAIM", "preferred_username");

    const { getConfig } = await importConfig();

    expect(getConfig()).toEqual({
      PORT: 4311,
      NODE_ENV: "test",
      SERVER_NAME: "custom-server",
      SERVER_VERSION: "2.0.0",
      LOG_LEVEL: "debug",
      AUTH_JWT_HEADER: "X-Identity",
      AUTH_JWKS_URL: "https://issuer.example.test/keys",
      AUTH_ISSUER: "issuer",
      AUTH_AUDIENCE: "audience",
      AUTH_ACTOR_CLAIM: "preferred_username",
    });
  });

  it("exits when environment configuration is invalid", async () => {
    vi.stubEnv("PORT", "not-a-number");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    const { getConfig } = await importConfig();

    expect(() => getConfig()).toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Invalid environment configuration"),
    );
  });
});
