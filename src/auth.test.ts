import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  actorFromPayload,
  normalizeActor,
  verifyJwtIdentity,
  type JwtAuthConfig,
} from "./auth.ts";

const config: JwtAuthConfig = {
  AUTH_JWT_HEADER: "X-Authenticated-JWT",
  AUTH_JWKS_URL: "https://issuer.example.test/keys",
  AUTH_ISSUER: "https://issuer.example.test/",
  AUTH_AUDIENCE: "beads-mcp",
  AUTH_ACTOR_CLAIM: "email",
};

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, keySet: createLocalJWKSet({ keys: [jwk] }) };
}

async function token(
  privateKey: Parameters<SignJWT["sign"]>[0],
  claims: Record<string, unknown> = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
    .setIssuer(config.AUTH_ISSUER)
    .setAudience(config.AUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("JWT identity authentication", () => {
  it("normalizes valid actors and rejects unsafe values", () => {
    expect(normalizeActor("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeActor("alice@example.com/other")).toBeUndefined();
  });

  it("uses the configured claim and falls back to sub", () => {
    expect(
      actorFromPayload(
        { email: "Alice@Example.com", sub: "fallback" },
        "email",
      ),
    ).toBe("alice@example.com");
    expect(actorFromPayload({ sub: "Fallback" }, "email")).toBe("fallback");
  });

  it("verifies the signature and required claims before returning the actor", async () => {
    const { privateKey, keySet } = await keys();
    const jwt = await token(privateKey, { email: "Alice@Example.com" });

    const identity = await verifyJwtIdentity(jwt, config, keySet);

    expect(identity.actor).toBe("alice@example.com");
    expect(identity.expiresAt).toBeTypeOf("number");
  });

  it("rejects expired, wrong-audience, and tampered JWTs", async () => {
    const { privateKey, keySet } = await keys();
    const expired = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(config.AUTH_ISSUER)
      .setAudience(config.AUTH_AUDIENCE)
      .setExpirationTime("0s")
      .sign(privateKey);
    const wrongAudience = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(config.AUTH_ISSUER)
      .setAudience("other-audience")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifyJwtIdentity(expired, config, keySet)).rejects.toThrow();
    await expect(
      verifyJwtIdentity(wrongAudience, config, keySet),
    ).rejects.toThrow();
    await expect(
      verifyJwtIdentity(`${wrongAudience.slice(0, -1)}x`, config, keySet),
    ).rejects.toThrow();
  });

  it("requires an expiration claim", async () => {
    const { privateKey, keySet } = await keys();
    const jwt = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(config.AUTH_ISSUER)
      .setAudience(config.AUTH_AUDIENCE)
      .sign(privateKey);

    await expect(verifyJwtIdentity(jwt, config, keySet)).rejects.toThrow();
  });
});
